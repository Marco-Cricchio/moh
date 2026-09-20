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
import { noulProbability, type JevAnswer, type JevClient } from "./client";
import {
  GUARDRAIL_QUESTIONS,
  GUARDRAIL_THRESHOLDS,
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
  /**
   * #843: where the judgment record goes, when the caller wants it appended
   * by the judge itself — the decision is computed after the client call,
   * so the record (which must carry it) can only be built here. Absent: the
   * client's own `record` result is used unchanged (legacy wiring).
   */
  append?: (record: Record<string, unknown>) => void;
}

/** Extracts and normalizes the judged state for a bash call. */
function bashState(command: string, cwd: string): GuardrailState {
  const git = gitSnapshot(cwd);
  return { command: command.slice(0, COMMAND_STATE_MAX), cwd, git };
}

function scoreOf(answers: Record<string, JevAnswer>, id: string): number {
  const a = answers[id];
  return a?.type === "score" && typeof a.score === "number" ? a.score : 0;
}

/**
 * #843: the key dimension a verdict was based on, and its probability — the
 * same priority the ratified badge uses (destructive first, then
 * exfiltration, then risk). A pass decided nothing, so it has none.
 * Thresholds come from GUARDRAIL_THRESHOLDS, never re-inlined (#843 review:
 * askBadge used to drift from the rule here).
 */
function keyDimensionOf(signals: GuardrailSignals, verdict: string): { dimension: string; probability: number } | undefined {
  if (verdict === "pass") return undefined;
  const t = GUARDRAIL_THRESHOLDS;
  if (signals.destructive >= t.askLow) return { dimension: "destructive", probability: signals.destructive };
  if (signals.exfiltration >= t.askLow) return { dimension: "exfiltration", probability: signals.exfiltration };
  return { dimension: "risk", probability: signals.riskLevel };
}

/** #843: the judgment record for a verdict (used on cache hits, where no
 * model/latency/usage exists to fabricate). */
function guardrailRecord(
  answers: Record<string, JevAnswer> | undefined,
  callId: string,
  judged: GuardrailState,
  verdict: GuardrailVerdict,
): Record<string, unknown> {
  const key =
    verdict.verdict === "ask"
      ? { dimension: verdict.keyDimension, probability: verdict.keyProbability }
      : verdict.verdict === "deny" && verdict.keyProbability !== undefined
        ? { dimension: verdict.keyDimension ?? "destructive", probability: verdict.keyProbability }
        : undefined;
  return {
    useCase: "guardrail",
    callId,
    tool: GUARDRAIL_TOOL,
    lethalOnly: false,
    // #848: a cache hit is distinguishable from a live judgment, and it
    // carries no fabricated measurements — nothing was sent to a model.
    cached: true,
    state: { command: judged.command, cwd: judged.cwd, git: judged.git },
    ...(answers !== undefined ? { answers } : {}),
    decision: verdict.verdict,
    ...(key !== undefined ? { keyDimension: key.dimension, keyProbability: key.probability } : {}),
  };
}

/** The ratified "uncertain" badge text, quoted in the permission modal.
 * #843 review: the key probability rides `keyDimensionOf` — it used to
 * always report `destructive`, even when exfiltration decided. */
export function askBadge(signals: GuardrailSignals): { badge: string; keyDimension: string; keyProbability: number } {
  const parts: string[] = [];
  const t = GUARDRAIL_THRESHOLDS;
  if (signals.destructive >= t.askLow) parts.push(`destructive ${signals.destructive.toFixed(2)}`);
  if (signals.exfiltration >= t.askLow) parts.push(`exfiltration ${signals.exfiltration.toFixed(2)}`);
  if (signals.riskLevel >= t.askRisk) parts.push(`risk ${signals.riskLevel.toFixed(2)}`);
  const key = keyDimensionOf(signals, "ask")!;
  return {
    badge: `Jev: caso incerto (${key.dimension} ${key.probability.toFixed(2)})`,
    keyDimension: key.dimension,
    keyProbability: key.probability,
  };
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

  // #846: the turn's passing calls, aggregated into one record. Volume is
  // the root cause of the cap: a pass decided nothing, so it does not need
  // one record each — but it must still be distinguishable from "never
  // judged", hence one aggregate per turn instead of silence or sampling.
  const passCallIds = new Set<string>();
  const aggregatePass = (callId: string): void => {
    passCallIds.add(callId);
  };

  return {
    /**
     * #846: flushes this turn's passing judgments as one aggregate record
     * (called at `afterTurn`); a turn with no passing calls records
     * nothing. The set resets for the next turn.
     */
    flushPasses(): void {
      if (passCallIds.size === 0) return;
      deps.append?.({ useCase: "guardrail_passes", calls: passCallIds.size, callIds: [...passCallIds] });
      passCallIds.clear();
    },
    /** Drops the cache when the git snapshot changed since the last look. */
    invalidateOnGitChange(): void {
      const git = gitSnapshot(process.cwd());
      if (git !== deps.state.lastGit) {
        cache.clear();
        deps.state.lastGit = git;
      }
    },
    /** #849: drops every cached verdict unconditionally — a permission-mode
     * rotation changes the judging band, so no verdict crosses it. */
    invalidateCache(): void {
      cache.clear();
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
      const cacheKey = guardrailStateKey(judged);
      const hit = cache.get(cacheKey);
      // #843: a cache hit is a real judgment record too — the verdict plus
      // the key probability ride along, no fabricated model/latency/usage.
      if (hit) {
        // #846: a cached pass joins the turn's aggregate; an ask/deny is
        // always recorded immediately (its verdict is safety-relevant).
        if (hit.verdict === "pass") aggregatePass(callId);
        else deps.append?.(guardrailRecord(undefined, callId, judged, hit));
        return { verdict: hit, cached: true, state: judged };
      }
      const lethalOnly = mode() === "yolo";
      const recordBase: Record<string, unknown> | undefined = deps.append ? {} : undefined;
      const outcome = await deps.client.judge({
        state: { command: judged.command, cwd: judged.cwd, git: judged.git },
        questions: GUARDRAIL_QUESTIONS,
        signal: undefined,
        // #843: when the judge owns the record (deps.append), the client
        // records nothing — the verdict is only known after this call.
        record:
          deps.append !== undefined
            ? () => null
            : (answers, meta) => ({
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
        destructive: noulProbability(answers, "destructive"),
        inScope: noulProbability(answers, "in_scope"),
        exfiltration: noulProbability(answers, "exfiltration"),
        riskLevel: scoreOf(answers, "risk_level"),
      };
      const decision = decideGuardrail(signals, lethalOnly);
      const key = keyDimensionOf(signals, decision.verdict);
      // #843: the record is built only now — the decision already made is
      // part of it. Complete, or not recorded at all: a fail-open pass is a
      // "no judgment", and inventing a verdict for it would lie.
      if (recordBase !== undefined) {
        recordBase.useCase = "guardrail";
        recordBase.callId = callId;
        recordBase.tool = GUARDRAIL_TOOL;
        recordBase.lethalOnly = lethalOnly;
        recordBase.state = { command: judged.command, cwd: judged.cwd, git: judged.git };
        recordBase.answers = answers;
        recordBase.model = outcome.model;
        recordBase.latencyMs = outcome.latencyMs;
        recordBase.usage = outcome.usage;
        recordBase.decision = decision.verdict;
        if (key !== undefined) {
          recordBase.keyDimension = key.dimension;
          recordBase.keyProbability = key.probability;
        }
        // #846: a passing live judgment joins the turn's aggregate record
        // (one `guardrail_passes` per turn, flushed at `afterTurn`); an
        // ask/deny is recorded immediately. The log still distinguishes
        // "judged and passed" from "never judged" — at one record per
        // turn, not one per bash call.
        if (decision.verdict === "pass") aggregatePass(callId);
        else deps.append!(recordBase);
      }
      let verdict: GuardrailVerdict;
      if (decision.verdict === "deny") {
        verdict = {
          verdict: "deny",
          reason: decision.reason ?? "denied by guardrail",
          ...(key !== undefined ? { keyDimension: key.dimension, keyProbability: key.probability } : {}),
        };
      } else if (decision.verdict === "ask") {
        const b = askBadge(signals);
        verdict = { verdict: "ask", badge: b.badge, keyDimension: b.keyDimension, keyProbability: b.keyProbability };
      } else verdict = { verdict: "pass", ...(decision.note !== undefined ? { note: decision.note } : {}) };
      cache.set(cacheKey, verdict);
      return { verdict, cached: false, state: judged, signals };
    },
  };
}

export type GuardrailJudge = ReturnType<typeof createGuardrailJudge>;
