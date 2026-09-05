/**
 * #499: local-measured usage aggregation from a session event log. The
 * universal fallback row of the quota modal: session tokens per model,
 * summed over the `model_call` events (same rollup the `done` event's
 * turn totals derive from). Failed calls are excluded — they consumed
 * nothing measurable.
 */
import type { AgentEvent } from "../types";

export interface LocalUsageRow {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Epoch ms of the last model_call for this model. */
  lastCallAt?: number;
}

/** Aggregates per-model usage from raw events (in-memory session). */
export function aggregateLocalUsage(events: readonly AgentEvent[]): LocalUsageRow[] {
  const byModel = new Map<string, LocalUsageRow>();
  for (const event of events) {
    if (event.type !== "model_call" || event.failed) continue;
    let row = byModel.get(event.model);
    if (!row) {
      row = { model: event.model, calls: 0, inputTokens: 0, outputTokens: 0 };
      byModel.set(event.model, row);
    }
    row.calls += 1;
    row.inputTokens += event.usage.inputTokens;
    row.outputTokens += event.usage.outputTokens;
  }
  return [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}
