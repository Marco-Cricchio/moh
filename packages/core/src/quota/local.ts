/**
 * #499: local-measured usage aggregation from a session event log. The
 * universal fallback row of the quota modal: session tokens per model,
 * summed over the `model_call` events (same rollup the `done` event's
 * turn totals derive from). Failed calls are excluded — they consumed
 * nothing measurable.
 */
import type { AgentEvent } from "../types";
import { estimateModelCost } from "../pricing";
import type { BillingPlan } from "../model-catalog";

export interface LocalUsageRow {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Epoch ms of the last model_call for this model. */
  lastCallAt?: number;
  /** Estimated USD from the release-pinned pricing table. Absent when the
   * model has no unambiguous price record. */
  estimatedCostUsd?: number;
}

/** ADR-0046 billing plan: resolves the plan of the endpoint a
 * `endpoint/model-id` ref names. Absent resolver or absent declaration =
 * `metered`, the default plan. */
export type BillingPlanResolver = (endpoint: string) => BillingPlan | undefined;

/** The endpoint segment of a `endpoint/model-id` ref (undefined for a bare
 * model id). */
function endpointOf(model: string): string | undefined {
  const slash = model.indexOf("/");
  return slash === -1 ? undefined : model.slice(0, slash);
}

/** Aggregates per-model usage from raw events (in-memory session).
 * `planFor` supplies the endpoint billing plans (ADR-0046): the estimate
 * then uses the endpoint's own price entry, exactly like the live quota
 * modal. Absent = metered for every model. */
export function aggregateLocalUsage(
  events: readonly AgentEvent[],
  options: { planFor?: BillingPlanResolver } = {},
): LocalUsageRow[] {
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
    const plan = options.planFor?.(endpointOf(event.model) ?? "") ?? "metered";
    const estimate = estimateModelCost(event.model, event.usage, plan);
    if (estimate) row.estimatedCostUsd = (row.estimatedCostUsd ?? 0) + estimate.usd;
  }
  return [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}
