/**
 * The guardrail's judge (#786): turns one bash tool-call context into a
 * verdict — the bridge between the hook, the four questions, the client
 * and the session cache.
 *
 * Ratified flow: Jev judges EVERY bash call (allow-listed or not — judging
 * what the rules already let through is the point). Gate order lives in
 * the core (Jev → rule deny → ask flow → allow, ADR-0031 wiring from
 * #784). Fail-open: any client failure means "no judgment", pass.
 */
import type { JevAnswer, JevClient } from "./client";
import {
  GUARDRAIL_QUESTIONS,
  decideGuardrail,
  type GuardrailSignals,
} from "./guardrail";
import {
  createGuardrailCache,
  gitSnapshot,
  guardrailStateKey,
  type GuardrailState,
  type GuardrailVerdict,
} from "./session-state";

/** The tool this guardrail gates in v1 (ratified: bash only). */
export const GUARDRAIL_TOOL = "bash";

/** Maximum judged-state command length sent to Jev. */
const COMMAND_STATE_MAX = 4000;

export interface GuardrailJudgeResult {
  /** The verdict; `pass` also covers "no judgment" (fail-open) and cache hits. */
  verdict: GuardrailVerdict;
  /** True when the verdict came from the session cache, not a live call. */
  cached: boolean;
  /** The judged state (what Jev saw), for the jev_judgment record. */
  state: GuardrailState;
  /** Signals when the call produced answers (absent on fail-open). */
  signals?: GuardrailSignals;
}

export interface GuardrailJudgeDeps {
  client: Pick<JevClient, "judge">;
  /** The extension state store (cache + last git snapshot live here). */
  state: Record<string, unknown>;
}

/** Extracts and normalizes the judged state for a bash call. */
function bashState(command: string, cwd: string): GuardrailState {
  const git = gitSnapshot(cwd);
  return { command: command.slice(0, COMMAND_STATE_MAX), cwd, git };
}

function noul(answers: Record<string, JevAnswer>, id: string): number {
  const a = answers[id];
  return a?.type === "noul" && typeof a.noul === "number" ? a.noul : 0;
}

function scoreOf(answers: Record<string, JevAnswer>, id: string): number {
  const a = answers[id];
  return a?.type === "score" && typeof a.score === "number" ? a.score : 0;
}

/** The ratified "uncertain" badge text, quoted in the permission modal. */
export function askBadge(signals: GuardrailSignals): { badge: string; keyProbability: number } {
  const parts: string[] = [];
  if (signals.destructive >= 0.4) parts.push(`destructive ${signals.destructive.toFixed(2)}`);
  if (signals.exfiltration >= 0.4) parts.push(`exfiltration ${signals.exfiltration.toFixed(2)}`);
  if (signals.riskLevel >= 0.75) parts.push(`risk ${signals.riskLevel.toFixed(2)}`);
  const key = parts[0] ?? `risk ${signals.riskLevel.toFixed(2)}`;
  return { badge: `Jev: caso incerto (${key})`, keyProbability: signals.destructive };
}

export interface GuardrailJudgeHost {
  /** Current session mode; "yolo" switches to lethal-only checks. */
  mode: () => "normal" | "auto-accept" | "yolo";
  /** The effective cwd the bash command runs in (best-effort from args). */
  cwd: (args: unknown) => string;
}

const UNKNOWN_MODE = (): "normal" => "normal";
const DEFAULT_CWD = (): string => process.cwd();

/**
 * Builds the per-session judge. Uses the extension's durable `state` store
 * so a hot-reload keeps the cache and the last git snapshot.
 */
export function createGuardrailJudge(
  deps: GuardrailJudgeDeps,
  host: Partial<GuardrailJudgeHost> = {},
) {
  const mode = host.mode ?? UNKNOWN_MODE;
  const cwdOf = host.cwd ?? DEFAULT_CWD;
  const cache = (deps.state.cache as ReturnType<typeof createGuardrailCache> | undefined) ?? createGuardrailCache();
  deps.state.cache = cache;
  const lastGit = (deps.state.lastGit as string | null | undefined) ?? null;
  deps.state.lastGit = lastGit;

  return {
    /** Drops the cache when the git snapshot changed since the last look. */
    invalidateOnGitChange(): void {
      const git = gitSnapshot(process.cwd());
      if (git !== deps.state.lastGit) {
        cache.clear();
        deps.state.lastGit = git;
      }
    },
    /** Cache emptying on session end (state is durable across reloads, so explicit). */
    reset(): void {
      cache.clear();
      deps.state.lastGit = null;
    },
    /**
     * Judges one bash call. Never throws; a client failure is a cached
     * `pass` (fail-open) — but is NOT stored in the cache under the key
     * (an offline blip must not pin a verdict for the whole session).
     */
    async judge(callId: string, args: unknown): Promise<GuardrailJudgeResult> {
      const a = (args ?? {}) as Record<string, unknown>;
      const command = typeof a.command === "string" ? a.command : "";
      if (!command) return { verdict: { verdict: "pass" }, cached: false, state: { command: "", cwd: cwdOf(args), git: null } };
      const judged = bashState(command, cwdOf(args));
      const key = guardrailStateKey(judged);
      const hit = cache.get(key);
      if (hit) return { verdict: hit, cached: true, state: judged };
      const lethalOnly = mode() === "yolo";
      const outcome = await deps.client.judge({
        state: { command: judged.command, cwd: judged.cwd, git: judged.git },
        questions: GUARDRAIL_QUESTIONS,
        signal: undefined,
        record: (answers, meta) => ({
          useCase: "guardrail",
          callId,
          tool: GUARDRAIL_TOOL,
          lethalOnly,
          state: { command: judged.command, cwd: judged.cwd, git: judged.git },
          answers,
          model: meta.model,
          latencyMs: meta.latencyMs,
          usage: meta.usage,
        }),
      });
      if (!outcome.ok) {
        // Fail-open, uncached: the next identical call retries the API.
        return { verdict: { verdict: "pass" }, cached: false, state: judged };
      }
      const answers = outcome.answers;
      const signals: GuardrailSignals = {
        destructive: noul(answers, "destructive"),
        inScope: noul(answers, "in_scope"),
        exfiltration: noul(answers, "exfiltration"),
        riskLevel: scoreOf(answers, "risk_level"),
      };
      const decision = decideGuardrail(signals, lethalOnly);
      let verdict: GuardrailVerdict;
      if (decision.verdict === "deny") verdict = { verdict: "deny", reason: decision.reason ?? "denied by guardrail" };
      else if (decision.verdict === "ask") {
        const b = askBadge(signals);
        verdict = { verdict: "ask", badge: b.badge, keyProbability: b.keyProbability };
      } else verdict = { verdict: "pass" };
      cache.set(key, verdict);
      return { verdict, cached: false, state: judged, signals };
    },
  };
}

export type GuardrailJudge = ReturnType<typeof createGuardrailJudge>;
