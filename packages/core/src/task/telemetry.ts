/**
 * #1101 (P2 task-outcome telemetry): the producers and normalizers for
 * explicit, client-seamed task outcomes. Only a client seam creates a
 * task record — moh never infers success from assistant prose, tool
 * errors or sentiment, and absence of a signal stays `unknown` in every
 * projection (never success, never failure).
 *
 * Everything here is metadata only: a task id (user-declared or
 * generated, no content), a verification verdict with its command
 * category and bounded redacted summary — never prompt text, never
 * source content, never full tool output, never credentials.
 */
import type { AgentEvent } from "../types";

export type TaskDeclaredEvent = Extract<AgentEvent, { type: "task_declared" }>;
export type TaskVerificationEvent = Extract<AgentEvent, { type: "task_verification" }>;
export type TaskOutcomeEvent = Extract<AgentEvent, { type: "task_outcome" }>;

export type VerificationCategory = TaskVerificationEvent["category"];
export type TaskOutcome = TaskOutcomeEvent["outcome"];

/** The upper bound of a verification summary after redaction. Anything
 * longer is truncated — the diagnostics stay *metadata*, never output. */
export const SUMMARY_MAX_CHARS = 240;

/**
 * The one sanitizer for verification diagnostics metadata: collapses to a
 * single line, truncates to the 240-char bound, and redacts credential-
 * shaped tokens (assignment or URL-carried keys/tokens/passwords). The
 * redaction is deliberately coarse — a summary that survives is safe by
 * construction, not by review.
 */
export function redactSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const redacted = oneLine
    // key=value / key: value assignments for credential-ish names.
    .replace(/((?:api[-_]?|access[-_]?|auth[-_]?|secret|token|key|password|credential)[a-z0-9_-]*\s*[=:]\s*)(\S+)/gi, "$1[redacted]")
    // URL-carried credentials (?key=…, #token=…, &password=…).
    .replace(/([?&#](?:api[-_]?key|token|key|password|secret)[=])([^&#\s]+)/gi, "$1[redacted]");
  return redacted.length > SUMMARY_MAX_CHARS ? `${redacted.slice(0, SUMMARY_MAX_CHARS - 1)}…` : redacted;
}

/** A task id after trimming; undefined when nothing usable remains
 * (empty, whitespace) — the caller refuses visibly, never invents one
 * the user did not ask for when they passed an explicit blank. */
export function normalizeTaskId(taskId: string): string | undefined {
  const trimmed = taskId.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : undefined;
}

/** Builds the `task_declared` event for a client's `declareTask` call.
 * `reopens` names the original task of a revision/reopen relation. */
export function taskDeclaredEvent(options: {
  taskId: string;
  reopens?: string;
  declaredAt?: string;
}): TaskDeclaredEvent {
  return {
    type: "task_declared",
    taskId: options.taskId,
    ...(options.reopens ? { reopens: options.reopens } : {}),
    declaredAt: options.declaredAt ?? new Date().toISOString(),
  };
}

/** Builds the `task_verification` event for a client's `recordVerification`
 * call. The summary is redacted and bounded here, at the single seam — a
 * caller cannot smuggle unbounded or credential-bearing diagnostics past
 * it. Absent numbers stay absent (unknown, never zero). */
export function taskVerificationEvent(options: {
  taskId: string;
  verificationId: string;
  category: VerificationCategory;
  ok: boolean;
  exitStatus?: number;
  durationMs?: number;
  summary?: string;
  recordedAt?: string;
}): TaskVerificationEvent {
  const summary = options.summary !== undefined ? redactSummary(options.summary) : undefined;
  return {
    type: "task_verification",
    taskId: options.taskId,
    verificationId: options.verificationId,
    category: options.category,
    ok: options.ok,
    ...(options.exitStatus !== undefined ? { exitStatus: options.exitStatus } : {}),
    ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    ...(summary ? { summary } : {}),
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  };
}

/** Builds the `task_outcome` event for a client's `recordTaskOutcome`
 * call. `unresolved` is an explicit close-without-verdict; the *absence*
 * of this event is what projections read as `unknown`. */
export function taskOutcomeEvent(options: {
  taskId: string;
  outcome: TaskOutcome;
  decidedAt?: string;
}): TaskOutcomeEvent {
  return {
    type: "task_outcome",
    taskId: options.taskId,
    outcome: options.outcome,
    decidedAt: options.decidedAt ?? new Date().toISOString(),
  };
}
