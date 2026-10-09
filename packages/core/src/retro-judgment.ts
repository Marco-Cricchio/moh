/**
 * Retro judgement extraction (ADR-0075, #1275) — the second pipeline.
 *
 * Mechanical categories are derived deterministically in `retro.ts`; the
 * judgement categories (navigation, coding standards) need reading a
 * session the way a reviewer would, so they come from a maintenance
 * subagent. Per the ADR the extraction rules live *with the subagent*:
 * this module owns the plumbing (batch selection, the child session, the
 * reply parser) and the subagent owns the judgement.
 *
 * Cost stays proportional to aggregate value: the run is triggered on a
 * threshold — a batch of `RETRO_JUDGMENT_BATCH` closed sessions — never
 * after every session. The batch counter and its last-run stamp live in
 * the retro store (sibling of the findings), so the trigger survives
 * process restarts and is testable without a model call.
 */
import { existsSync } from "node:fs";
import type { Provider } from "./types";
import type { AgentEvent } from "./types";
import { retroSignature, type RetroCandidate } from "./retro";
import { PromptComposer } from "./prompt-composer";
import { SessionStore, listSessionSummaries, lastAssistantText, type SessionSummary } from "./session-store";

/** Closed sessions per judgement batch (owner decision, 2026-10-09). */
export const RETRO_JUDGMENT_BATCH = 10;
/** Chars of one session's transcript handed to the subagent. */
export const RETRO_JUDGMENT_TRANSCRIPT_CHARS = 4000;
/** Chars of all transcripts together (the batch budget). */
export const RETRO_JUDGMENT_BATCH_CHARS = 24000;
/** Findings one judgement run may contribute. */
export const RETRO_JUDGMENT_MAX_FINDINGS = 10;

/** The subagent's role prompt: the judgement rules, not the plumbing. */
export const RETRO_JUDGMENT_PROMPT = [
  "You are moh's retro judgement subagent. You read a batch of closed coding sessions and report environment improvements a reviewer would notice.",
  "",
  "You judge two categories only:",
  '- "navigation": the agent spent a long time finding the right file, or a hidden dependency between files cost it a detour. The fix is a navigation pointer in AGENTS.md or a doc.',
  '- "coding-standards": a mistake a rule could have caught, or a convention the agent broke that no guardrail enforces. Prefer a deterministic check over prose; reserve a standards rule for genuine judgement calls.',
  "",
  "Rules:",
  '- Respond with ONLY a JSON array: [{"category": "navigation"|"coding-standards", "evidence": "<one line>", "confidence": <0..1>, "session": "<the session id it came from>"}] — an empty array when nothing qualifies.',
  "- One finding per distinct observation. Never repeat the same observation twice in a batch.",
  "- Evidence is one line of what you saw, no secrets, no code dumps.",
  "- Confidence is your own: 0.5-0.6 for a hunch, 0.8+ only when the transcript makes it plain.",
  "- Never propose a change to the system prompt; steering-file changes are the human's decision.",
].join("\n");

/** One closed session handed to the judgement subagent. */
export interface RetroJudgmentSession {
  /** The session id, echoed back in each finding's `session`. */
  id: string;
  transcript: string;
}

export interface RetroJudgmentInput {
  sessions: ReadonlyArray<RetroJudgmentSession>;
  signal?: AbortSignal;
}

/** The judgement pipeline's extractor seam (tests, clients). */
export type RetroJudgmentExtractor = (input: RetroJudgmentInput) => Promise<RetroCandidate[]>;

/**
 * Parses the subagent's reply into candidates. Throws on unparseable
 * output (the caller fails silent). Findings whose `session` tag is not
 * one of the batch's ids are dropped — provenance is never guessed.
 */
export function parseJudgmentFindings(text: string, sessionIds: ReadonlyArray<string>): RetroCandidate[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON array found in judgement output");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`invalid judgement JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed)) throw new Error("judgement output is not an array");
  const known = new Set(sessionIds);
  const findings: RetroCandidate[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const category = String(row.category ?? "").trim();
    const evidence = String(row.evidence ?? "").replace(/\s+/g, " ").trim();
    const session = String(row.session ?? "").trim();
    if (!category || !evidence || !known.has(session)) continue;
    const raw = typeof row.confidence === "number" && Number.isFinite(row.confidence) ? row.confidence : 0.5;
    findings.push({
      category,
      evidence,
      confidence: Math.min(1, Math.max(0, raw)),
      session,
      signature: retroSignature(category, evidence),
    });
    if (findings.length >= RETRO_JUDGMENT_MAX_FINDINGS) break;
  }
  return findings;
}

/** The default judgement extractor: an in-process maintenance subagent,
 * no tools, no subagents of its own (depth discipline, #339). */
export function createRetroJudgmentExtractor(provider: Provider, cwd: string): RetroJudgmentExtractor {
  return async (input) => {
    if (input.sessions.length === 0) return [];
    // Lazy: a static import would make this module and session.ts a cycle.
    const { AgentSession } = await import("./session/session");
    const child = new AgentSession({
      provider,
      tools: {},
      cwd,
      subagents: null,
      promptComposer: new PromptComposer({ projectDir: cwd, basePrompt: RETRO_JUDGMENT_PROMPT }),
    });
    input.signal?.addEventListener("abort", () => child.abort(), { once: true });
    try {
      const user = [
        "# Closed sessions",
        ...input.sessions.map((session) => `\n## session ${session.id}\n${session.transcript}`),
        "",
        "Report environment improvements per your rules. Respond with only the JSON array.",
      ].join("\n");
      const turn = await child.send(user);
      if (turn.status !== "done") throw new Error(`retro judgement subagent ended ${turn.status}`);
      return parseJudgmentFindings(lastAssistantText(child.history()), input.sessions.map((s) => s.id));
    } finally {
      await child.dispose().catch(() => {});
    }
  };
}

/** A compact transcript: the user messages and the tools the agent reached
 * for — enough to judge navigation and standards, small enough to batch. */
export function retroTranscript(events: ReadonlyArray<AgentEvent>): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "user_message") lines.push(`user: ${event.text.replace(/\s+/g, " ").trim()}`);
    else if (event.type === "tool_call") lines.push(`tool: ${event.name}`);
    else if (event.type === "error") lines.push(`error: ${event.message}`);
  }
  const text = lines.join("\n");
  return text.length > RETRO_JUDGMENT_TRANSCRIPT_CHARS ? text.slice(0, RETRO_JUDGMENT_TRANSCRIPT_CHARS) : text;
}

/**
 * Selects the batch: the newest `RETRO_JUDGMENT_BATCH` closed sessions,
 * excluding the session currently open. Reads each log read-only; an
 * unreadable session is skipped, never fatal. Returns [] when the batch
 * is empty.
 */
export function selectJudgmentBatch(
  summaries: ReadonlyArray<SessionSummary>,
  opts: { exclude?: string } = {},
): RetroJudgmentSession[] {
  const chosen: RetroJudgmentSession[] = [];
  let budget = RETRO_JUDGMENT_BATCH_CHARS;
  for (const summary of summaries) {
    if (chosen.length >= RETRO_JUDGMENT_BATCH) break;
    if (summary.id === opts.exclude) continue;
    if (!existsSync(summary.file)) continue;
    let store: SessionStore | null = null;
    try {
      store = SessionStore.open(summary.file, { register: false });
      const events = store.load();
      const transcript = retroTranscript(events);
      if (!transcript) continue;
      budget -= transcript.length;
      if (budget < 0) break;
      chosen.push({ id: summary.id, transcript });
    } catch {
      // an unreadable session is skipped: the batch is best-effort
    } finally {
      store?.dispose();
    }
  }
  return chosen;
}

/** Reads the project's closed sessions, newest first, for the batch. */
export function closedSessions(cwd: string, home: string): SessionSummary[] {
  try {
    return listSessionSummaries(cwd, home);
  } catch {
    return [];
  }
}
