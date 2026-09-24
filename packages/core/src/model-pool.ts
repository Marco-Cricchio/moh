/**
 * #787: which models a session can actually route to.
 *
 * Generic on purpose — the core knows "the models reachable through the
 * configured endpoints", never *who* wants to route. A bundled extension
 * receives this pool as data; the core stays free of use-case logic.
 *
 * Rules (ratified for the routing use case):
 * - only real, configured models: an endpoint's shipped catalog, or the
 *   live listing for an endpoint with no catalog (a catalog-less
 *   openai-compat/custom host). A failed listing contributes nothing.
 * - the ref is always `endpoint/model-id` — exactly what `switchModel`
 *   resolves.
 * - the price is the catalog's blended input+output USD per Mtok; absent
 *   means unknown (never free), which the consumer maps to its own
 *   conservative default.
 *
 * The returned provider resolves once per session (lazy, memoized):
 * catalogs are synchronous, the live listings are one fetch per endpoint,
 * and every failure degrades to a smaller pool instead of an error.
 */
import type { EndpointProfile } from "./config";
import { endpointModelCatalog, pricingForModel, type ModelPricing } from "./model-catalog";
import { listOpenAiCompatModels } from "./endpoint-models";

/** One model a session may route to. */
export interface AvailableModel {
  /** `endpoint/model-id` — the ref `switchModel` resolves. */
  readonly ref: string;
  /** Blended USD price per Mtok (input + output); absent = unknown. */
  readonly price?: number;
}

export interface ModelPoolOptions {
  /** Live-listing seam (tests). Default: `GET <baseUrl>/models`. */
  listModels?: (baseUrl: string, apiKey?: string) => Promise<string[]>;
}

/** What one resolution produced: the models, plus its own degradations. */
export interface ModelPoolResult {
  readonly models: readonly AvailableModel[];
  /**
   * Non-fatal failures (a listing that did not answer): the models of that
   * endpoint are simply not routable, and the consumer reports the reason
   * once. Never thrown — a broken endpoint must not take routing down.
   */
  readonly warnings: readonly string[];
}

/**
 * Blended price for tier ranking: input + output per Mtok. Zero-only
 * records are placeholders, not evidence of a free model (the same rule
 * `pricingForModel` applies) — they count as unknown.
 */
export function blendedPrice(pricing: ModelPricing | undefined): number | undefined {
  if (!pricing) return undefined;
  if (pricing.input <= 0 && pricing.output <= 0) return undefined;
  return pricing.input + pricing.output;
}

/**
 * Builds the pool provider for a session. Call it once (the assembly does)
 * and invoke the result lazily: nothing is resolved — and no listing is
 * fetched — until something asks for the pool.
 */
export function createModelPool(
  endpoints: readonly EndpointProfile[],
  options: ModelPoolOptions = {},
): () => Promise<ModelPoolResult> {
  const listModels = options.listModels ?? ((baseUrl, apiKey) => listOpenAiCompatModels(baseUrl, apiKey));
  /** In-session memo: one resolution, one listing per endpoint. */
  let pending: Promise<ModelPoolResult> | undefined;

  const resolve = async (): Promise<ModelPoolResult> => {
    const out: AvailableModel[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const push = (ref: string, price: number | undefined): void => {
      if (seen.has(ref)) return;
      seen.add(ref);
      out.push(price !== undefined ? { ref, price } : { ref });
    };
    for (const endpoint of endpoints) {
      const catalog = endpointModelCatalog(endpoint.type, endpoint.baseUrl);
      if (catalog.length > 0) {
        for (const model of catalog) push(`${endpoint.name}/${model.id}`, blendedPrice(model.pricing));
        continue;
      }
      // No shipped catalog: the live listing is the only source of truth
      // for which models exist here. `openai-compat` (and a custom type
      // registered with a base URL) speaks `GET /models`.
      if (!endpoint.baseUrl) continue;
      try {
        const ids = await listModels(endpoint.baseUrl, endpoint.apiKey);
        for (const id of ids) push(`${endpoint.name}/${id}`, blendedPrice(pricingForModel(`${endpoint.name}/${id}`)));
      } catch (err) {
        warnings.push(`endpoint "${endpoint.name}": listing failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return { models: out, warnings };
  };

  return () => (pending ??= resolve());
}
