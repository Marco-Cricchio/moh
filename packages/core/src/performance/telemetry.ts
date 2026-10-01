/**
 * #1101 (P2 performance and task-outcome telemetry): read-only
 * projections over session event logs — no second source of truth, every
 * number derives from events already in the log (P0 attempt records,
 * #1101 task events, subagent spawn/result linkage).
 *
 * Two projections live here:
 *
 * - `performanceByModel` — latency and reliability per model: TTFC,
 *   active provider-processing duration, retry/wait time (reconstructed
 *   from attempt-chain gaps, kept strictly separate from processing
 *   time), p50/p95 latency and the interrupted-call rate. These are
 *   *measured performance* numbers; they are never productivity claims.
 * - `taskReport` — the explicit task-outcome layer: declared tasks,
 *   their verification runs, the contributing calls (by log-order
 *   interval), and the per-accepted-task cost rollup computed only where
 *   acceptance evidence exists. A task without an outcome event stays
 *   `unknown`.
 *
 * Everything is metadata only: model refs, durations, counts, task ids —
 * never prompt text, completions, source content or unbounded output.
 */
import type { AgentEvent } from "../types";
import { attemptChains } from "../telemetry";
import type { BillingPlanResolver } from "../quota/local";
import { estimateModelCost } from "../pricing";

// ---------------------------------------------------------------------------
// Performance projection
// ---------------------------------------------------------------------------

/** Percentile over a sample list (nearest-rank on the sorted copy). */
export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export interface PerformanceModelRow {
  model: string;
  /** Logical calls that ran at least one attempt on this model. */
  calls: number;
  completed: number;
  failed: number;
  /** Attempts cut short by a cancel — the interrupted-call numerator. */
  aborted: number;
  /** aborted / calls (0 when there are no calls). */
  interruptedRate: number;
  /** Sum of attempt durations — active provider processing time.
   * Retry/wait gaps are NOT in here. */
  activeDurationMs: number;
  /** Wall-clock gaps between consecutive attempts of one logical call
   * that served on the *same* model — the retry/backoff/wait time,
   * strictly outside activeDurationMs. A fallback move's gap belongs to
   * the chain, not to either model: moh never assumes equivalence. */
  waitDurationMs: number;
  /** Time to first content (completed attempts that streamed text):
   * p50 and p95; undefined when no attempt streamed text. */
  ttfc?: { p50Ms: number; p95Ms: number; samples: number };
  /** Attempt latency (completed attempts): p50 and p95. */
  latency?: { p50Ms: number; p95Ms: number };
}

/** #1101: collects the completed attempts' TTFC and latency samples per
 * model — the raw material the percentiles recompute from when several
 * sessions merge (percentiles never sum; samples do). */
export function performanceSamples(events: readonly AgentEvent[]): Map<string, { ttfc: number[]; latency: number[] }> {
  const samples = new Map<string, { ttfc: number[]; latency: number[] }>();
  for (const event of events) {
    if (event.type !== "model_call" || !event.attempt) continue;
    const attempt = event.attempt;
    if (attempt.outcome !== "completed") continue;
    const entry = samples.get(attempt.servingModel) ?? { ttfc: [], latency: [] };
    if (attempt.ttfcMs !== undefined) entry.ttfc.push(attempt.ttfcMs);
    entry.latency.push(attempt.durationMs);
    samples.set(attempt.servingModel, entry);
  }
  return samples;
}

/** Per-model performance from one session's events (attempt-chain
 * derived; no prompt text read). */
export function performanceByModel(events: readonly AgentEvent[]): PerformanceModelRow[] {
  // Raw attempt records with their timestamps, in log order — the chain
  // projection strips timing, and the wait gaps need the boundaries.
  const records = events
    .filter((e): e is Extract<AgentEvent, { type: "model_call" }> => e.type === "model_call" && e.attempt !== undefined)
    .map((e) => e.attempt!);
  const chains = attemptChains(events);
  const rows = new Map<string, PerformanceModelRow>();
  for (const chain of chains) {
    let previous: (typeof chain)["attempts"][number] | undefined;
    for (const attempt of chain.attempts) {
      const row = rows.get(attempt.servingModel) ?? {
        model: attempt.servingModel,
        calls: 0,
        completed: 0,
        failed: 0,
        aborted: 0,
        interruptedRate: 0,
        activeDurationMs: 0,
        waitDurationMs: 0,
      };
      // A logical call counts once per model — on the model's first
      // attempt of that call (retries keep the model; a fallback move
      // counts the call on both models it touched).
      if (previous === undefined || previous.servingModel !== attempt.servingModel) row.calls += 1;
      row.activeDurationMs += attempt.durationMs;
      if (attempt.outcome === "completed") row.completed += 1;
      else if (attempt.outcome === "failed") row.failed += 1;
      else row.aborted += 1;
      rows.set(attempt.servingModel, row);
      previous = attempt;
    }
  }
  // Same-model retry gaps: the reconstructed wait between consecutive
  // attempts of one logical call that served on the same model. A
  // fallback move's gap belongs to the chain, not to either model.
  const attemptById = new Map(records.map((a) => [a.attemptId, a]));
  for (const chain of chains) {
    for (let i = 1; i < chain.attempts.length; i++) {
      const summary = chain.attempts[i]!;
      const attempt = attemptById.get(summary.attemptId);
      const prev = attemptById.get(chain.attempts[i - 1]!.attemptId);
      if (!attempt || !prev || summary.outcome === "aborted") continue;
      if (prev.servingModel !== summary.servingModel) continue;
      const prevEnd = Date.parse(prev.endedAt);
      const start = Date.parse(attempt.startedAt);
      if (Number.isNaN(prevEnd) || Number.isNaN(start)) continue;
      const row = rows.get(summary.servingModel)!;
      row.waitDurationMs += Math.max(0, start - prevEnd);
    }
  }
  // TTFC and latency percentiles: one pass over the records.
  const ttfcSamples = new Map<string, number[]>();
  const latencySamples = new Map<string, number[]>();
  for (const attempt of records) {
    if (attempt.outcome !== "completed") continue;
    if (attempt.ttfcMs !== undefined) {
      const list = ttfcSamples.get(attempt.servingModel) ?? [];
      list.push(attempt.ttfcMs);
      ttfcSamples.set(attempt.servingModel, list);
    }
    const list = latencySamples.get(attempt.servingModel) ?? [];
    list.push(attempt.durationMs);
    latencySamples.set(attempt.servingModel, list);
  }
  const result: PerformanceModelRow[] = [];
  for (const row of rows.values()) {
    row.interruptedRate = row.calls > 0 ? row.aborted / row.calls : 0;
    const ttfc = ttfcSamples.get(row.model);
    if (ttfc && ttfc.length > 0) {
      ttfc.sort((a, b) => a - b);
      row.ttfc = { p50Ms: percentile(ttfc, 50)!, p95Ms: percentile(ttfc, 95)!, samples: ttfc.length };
    }
    const latency = latencySamples.get(row.model);
    if (latency && latency.length > 0) {
      latency.sort((a, b) => a - b);
      row.latency = { p50Ms: percentile(latency, 50)!, p95Ms: percentile(latency, 95)! };
    }
    result.push(row);
  }
  return result.sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
}

/** Wall-clock concurrency over explicit call intervals, tagged by
 * session. Children carry their own session id (their own log); the
 * union is the honest wall-clock busy time, the sum double-counts every
 * overlap — analyses that must not double-count parent work use the
 * union (`concurrentMs` shows exactly what a naive total inflates). */
export interface ConcurrencyReport {
  /** Union of all intervals — the wall-clock busy time. */
  busyMs: number;
  /** Sum of the intervals' own durations (overlaps counted once per
   * interval). */
  sumMs: number;
  /** How much the sum exceeds the union — the overlap a naive total
   * would double-count across parent and concurrent child sessions. */
  concurrentMs: number;
  /** Maximum number of intervals simultaneously open. */
  maxDepth: number;
}

export function concurrencyReport(
  intervals: readonly { session: string; startMs: number; endMs: number }[],
): ConcurrencyReport {
  if (intervals.length === 0) return { busyMs: 0, sumMs: 0, concurrentMs: 0, maxDepth: 0 };
  const points: { ms: number; delta: number }[] = [];
  let sumMs = 0;
  for (const { startMs, endMs } of intervals) {
    const start = Math.min(startMs, endMs);
    const end = Math.max(startMs, endMs);
    sumMs += Math.max(0, end - start);
    points.push({ ms: start, delta: 1 }, { ms: end, delta: -1 });
  }
  points.sort((a, b) => a.ms - b.ms || a.delta - b.delta);
  let depth = 0;
  let maxDepth = 0;
  let busyMs = 0;
  let lastOpenMs = 0;
  for (const point of points) {
    if (depth === 0 && point.delta > 0) lastOpenMs = point.ms;
    depth += point.delta;
    if (depth === 0) busyMs += Math.max(0, point.ms - lastOpenMs);
    maxDepth = Math.max(maxDepth, depth);
  }
  return { busyMs, sumMs, concurrentMs: Math.max(0, sumMs - busyMs), maxDepth };
}

// ---------------------------------------------------------------------------
// Task-outcome projection
// ---------------------------------------------------------------------------

export interface TaskVerificationRow {
  verificationId: string;
  category: "test" | "typecheck" | "build" | "lint" | "other";
  ok: boolean;
  exitStatus?: number;
  durationMs?: number;
  recordedAt: string;
}

export interface TaskRow {
  taskId: string;
  /** The original task, when this one reopens it (revision relation). */
  reopens?: string;
  declaredAt: string;
  verifications: TaskVerificationRow[];
  /** The explicit user verdict; `undefined` = unknown — absence of a
   * signal is never success or failure. */
  outcome?: "accepted" | "rejected" | "revision-needed" | "unresolved";
  decidedAt?: string;
  /** The latest verification verdict *at the time the outcome was
   * decided* (`undefined` when the outcome is still open or no run had
   * happened by then): the failed-then-passed shape reads `passed` only
   * when a passing run followed the last failing one before the verdict. */
  verified?: "passed" | "failed";
  /** Contributing model calls: log-order interval (declaration → outcome
   * decision or log end), joined with the #1099 attempt records. One
   * entry per logical call; its attempt ids ride along. Child-session
   * calls stay in the child's own log — a cross-session rollup links
   * them through `subagent_spawn`/`subagent_result`, never duplicated
   * inside one session's projection. */
  contributingCalls: { callId: string; turnId: string; servingModel: string; endpointKind: string; attemptIds: string[] }[];
  /** Cost/tokens/calls rollup, computed ONLY when the task's outcome is
   * `accepted` — absent otherwise, never imputed. */
  accepted?: { calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd?: number };
}

export interface TaskReport {
  tasks: TaskRow[];
  /** Convenience counters. `unknown` counts tasks with no outcome event —
   * the default state, never conflated with success or failure. */
  accepted: number;
  rejected: number;
  revisionNeeded: number;
  unresolved: number;
  unknown: number;
}

type TaskState = {
  row: TaskRow;
  /** The task's declaration position in the log. */
  startIndex: number;
  /** The interval end: the outcome's position, or the log's end while
   * the outcome is still open. */
  endIndex: number;
};

/** The task-outcome projection over one session's events. Contributing
 * calls derive from log-order intervals (declaration → outcome decision
 * or log end), joined with the #1099 attempt records — no prompt text,
 * no tool output. */
export function taskReport(
  events: readonly AgentEvent[],
  options: { planFor?: BillingPlanResolver } = {},
): TaskReport {
  const states = new Map<string, TaskState>();
  const order: string[] = [];
  // Latest verification verdict as the log advances (repeated
  // verification, failed-then-passed).
  const verdicts = new Map<string, "passed" | "failed">();
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "task_declared") {
      if (!states.has(event.taskId)) {
        states.set(event.taskId, {
          row: {
            taskId: event.taskId,
            ...(event.reopens ? { reopens: event.reopens } : {}),
            declaredAt: event.declaredAt,
            verifications: [],
            contributingCalls: [],
          },
          startIndex: i,
          endIndex: events.length,
        });
        order.push(event.taskId);
      }
    } else if (event.type === "task_verification" && states.has(event.taskId)) {
      verdicts.set(event.taskId, event.ok ? "passed" : "failed");
      states.get(event.taskId)!.row.verifications.push({
        verificationId: event.verificationId,
        category: event.category,
        ok: event.ok,
        ...(event.exitStatus !== undefined ? { exitStatus: event.exitStatus } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        recordedAt: event.recordedAt,
      });
    } else if (event.type === "task_outcome" && states.has(event.taskId)) {
      const state = states.get(event.taskId)!;
      state.row.outcome = event.outcome;
      state.row.decidedAt = event.decidedAt;
      state.row.verified = verdicts.get(event.taskId);
      // The interval closes here: later calls belong to the next task.
      state.endIndex = i;
    }
  }
  // Contributing calls: a model_call belongs to the most recently
  // declared task whose [start, end) interval contains its position.
  const declared = order.map((id) => states.get(id)!).sort((a, b) => a.startIndex - b.startIndex);
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type !== "model_call" || event.failed || !event.attempt) continue;
    let state: TaskState | undefined;
    for (const candidate of declared) {
      if (candidate.startIndex < i && i < candidate.endIndex!) state = candidate;
    }
    if (!state) continue;
    const attempt = event.attempt;
    let contributing = state.row.contributingCalls.find((c) => c.callId === attempt.callId);
    if (!contributing) {
      contributing = {
        callId: attempt.callId,
        turnId: attempt.turnId,
        servingModel: attempt.servingModel,
        endpointKind: attempt.endpoint.kind,
        attemptIds: [],
      };
      state.row.contributingCalls.push(contributing);
    }
    contributing.attemptIds.push(attempt.attemptId);
  }
  // The accepted rollup: only on acceptance evidence, over the task's
  // contributing calls — their usage and estimated cost.
  const counters = { accepted: 0, rejected: 0, revisionNeeded: 0, unresolved: 0, unknown: 0 };
  for (const state of declared) {
    if (state.row.outcome !== "accepted") continue;
    let calls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let usd = 0;
    for (const event of events) {
      if (event.type !== "model_call" || event.failed) continue;
      const attempt = event.attempt;
      if (!attempt || !state.row.contributingCalls.some((c) => c.callId === attempt.callId)) continue;
      calls += 1;
      inputTokens += event.usage.inputTokens;
      outputTokens += event.usage.outputTokens;
      const slash = event.model.indexOf("/");
      const endpoint = slash === -1 ? "" : event.model.slice(0, slash);
      const estimate = estimateModelCost(event.model, event.usage, options.planFor?.(endpoint) ?? "metered");
      if (estimate) usd += estimate.usd;
    }
    state.row.accepted = {
      calls,
      inputTokens,
      outputTokens,
      ...(usd > 0 ? { estimatedCostUsd: usd } : {}),
    };
  }
  const tasks = order.map((id) => states.get(id)!.row);
  for (const task of tasks) {
    if (task.outcome === undefined) counters.unknown += 1;
    else if (task.outcome === "accepted") counters.accepted += 1;
    else if (task.outcome === "rejected") counters.rejected += 1;
    else if (task.outcome === "revision-needed") counters.revisionNeeded += 1;
    else counters.unresolved += 1;
  }
  return { tasks, ...counters };
}

// ---------------------------------------------------------------------------
// Follow-up fixture: quality-adjusted comparison of accepted tasks
// ---------------------------------------------------------------------------

/** One accepted task of the comparison fixture: what the report shows per
 * accepted task — the models that served its contributing calls, their
 * latency (from the P0 attempt records), whether the *first* verification
 * passed (verified first-pass success), how many reopens preceded the
 * accepted task, and the cost/tokens/calls rollup. Rows are built ONLY
 * from accepted tasks; tasks without acceptance evidence are excluded,
 * never imputed. These are measured numbers — never productivity claims. */
export interface AcceptedTaskFixtureRow {
  taskId: string;
  /** The distinct models that served the task's contributing calls. */
  servingModels: string[];
  /** Median completed-attempt latency across the contributing calls'
   * attempts (ms); absent with no completed attempt — never zero. */
  latencyP50Ms?: number;
  /** Whether the first verification run recorded for the task passed
   * (absent when no verification was run before acceptance). */
  verifiedFirstPass?: boolean;
  /** How many reopen relations precede this task in its revision chain. */
  revisions: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
}

/** Builds the accepted-task comparison fixture from a task report plus
 * the raw events of the same session(s) — the latency comes from the
 * attempt records the contributing callIds name. */
export function acceptedTaskFixture(report: TaskReport, events: readonly AgentEvent[]): AcceptedTaskFixtureRow[] {
  const attemptByCallId = new Map<string, { model: string; durations: number[] }>();
  for (const event of events) {
    if (event.type !== "model_call" || event.failed || !event.attempt) continue;
    const attempt = event.attempt;
    const entry = attemptByCallId.get(attempt.callId) ?? { model: attempt.servingModel, durations: [] };
    if (attempt.outcome === "completed") entry.durations.push(attempt.durationMs);
    entry.model = attempt.servingModel;
    attemptByCallId.set(attempt.callId, entry);
  }
  // Reopen chains: taskId → the number of reopens between it and the root.
  const depth = new Map<string, number>();
  const depthOf = (taskId: string, seen = new Set<string>()): number => {
    if (depth.has(taskId)) return depth.get(taskId)!;
    const task = report.tasks.find((t) => t.taskId === taskId);
    if (!task?.reopens || seen.has(taskId)) return 0;
    const value = 1 + depthOf(task.reopens, new Set([...seen, taskId]));
    depth.set(taskId, value);
    return value;
  };
  const rows: AcceptedTaskFixtureRow[] = [];
  for (const task of report.tasks) {
    if (task.outcome !== "accepted") continue;
    const models = new Set<string>();
    const durations: number[] = [];
    for (const call of task.contributingCalls) {
      const entry = attemptByCallId.get(call.callId);
      if (!entry) continue;
      models.add(entry.model);
      durations.push(...entry.durations);
    }
    durations.sort((a, b) => a - b);
    rows.push({
      taskId: task.taskId,
      servingModels: [...models].sort(),
      ...(durations.length > 0 ? { latencyP50Ms: durations[Math.floor((durations.length - 1) / 2)]! } : {}),
      ...(task.verifications.length > 0 ? { verifiedFirstPass: task.verifications[0]!.ok } : {}),
      revisions: depthOf(task.taskId),
      calls: task.accepted!.calls,
      inputTokens: task.accepted!.inputTokens,
      outputTokens: task.accepted!.outputTokens,
      ...(task.accepted!.estimatedCostUsd !== undefined ? { estimatedCostUsd: task.accepted!.estimatedCostUsd } : {}),
    });
  }
  return rows;
}
