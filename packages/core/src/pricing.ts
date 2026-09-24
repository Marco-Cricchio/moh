/**
 * #719: approximate model-cost estimates. Rates are release-pinned to the
 * model catalogs; no live endpoint can supply or override them.
 * Token accounting lacks cache-read/write and non-token billing dimensions,
 * therefore this intentionally estimates input + output tokens only.
 *
 * ADR-0046 (#959): the snapshot's provenance is the generated catalog
 * (`model-catalogs/manifest.json`, written by
 * `packages/core/scripts/build-model-catalogs.ts`) — the manifest is the one
 * place that knows which release the catalog belongs to and when it was
 * generated, so this module reads it instead of duplicating the facts.
 */
import { pricingForModel, type BillingPlan, type ModelPricing } from "./model-catalog";
import manifest from "./model-catalogs/manifest.json";

/** Provenance shown by client surfaces, from the committed manifest. */
export const PRICING_SNAPSHOT = {
  source: "moh model catalog",
  version: manifest.version,
  updatedAt: manifest.generatedAt.slice(0, 10),
} as const;

export interface ModelCostEstimate {
  /** Estimated USD for input and output tokens only. */
  usd: number;
  pricing: ModelPricing;
}

function rateFor(pricing: ModelPricing, inputTokens: number): ModelPricing {
  const tiers = pricing.tiers ?? [];
  return tiers
    .filter((tier) => inputTokens >= tier.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? pricing;
}

/** Estimates one completed call. Undefined means the model has no unique,
 * maintained price record for the endpoint's billing plan; callers must
 * render tokens only. */
export function estimateModelCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  plan: BillingPlan = "metered",
): ModelCostEstimate | undefined {
  const pricing = pricingForModel(model, plan);
  if (!pricing) return undefined;
  const rate = rateFor(pricing, usage.inputTokens);
  return { usd: (usage.inputTokens * rate.input + usage.outputTokens * rate.output) / 1_000_000, pricing: rate };
}

/** The billing plan of the endpoint a `endpoint/model-id` ref names, from
 * the endpoints a caller has at hand. Absent endpoint or absent declaration
 * = `metered` (ADR-0046: the plan is user-owned, never inferred). */
export function billingPlanResolver(
  endpoints: readonly { name: string; billingPlan?: BillingPlan }[] | undefined,
): (endpoint: string) => BillingPlan | undefined {
  const plans = new Map((endpoints ?? []).map((endpoint) => [endpoint.name, endpoint.billingPlan]));
  return (endpoint) => plans.get(endpoint);
}
