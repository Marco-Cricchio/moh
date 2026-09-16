/**
 * #719: approximate model-cost estimates. Rates are release-pinned to the
 * vendored model catalogs; no live endpoint can supply or override them.
 * Token accounting lacks cache-read/write and non-token billing dimensions,
 * therefore this intentionally estimates input + output tokens only.
 */
import { pricingForModel, type ModelPricing } from "./model-catalog";

/** Provenance shown by client surfaces. Update alongside catalog regeneration. */
export const PRICING_SNAPSHOT = {
  source: "vendored pi-ai model catalog",
  version: "0.85.0",
  updatedAt: "2026-09-16",
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
 * maintained price record; callers must render tokens only. */
export function estimateModelCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): ModelCostEstimate | undefined {
  const pricing = pricingForModel(model);
  if (!pricing) return undefined;
  const rate = rateFor(pricing, usage.inputTokens);
  return { usd: (usage.inputTokens * rate.input + usage.outputTokens * rate.output) / 1_000_000, pricing: rate };
}
