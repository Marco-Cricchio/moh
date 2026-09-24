/**
 * The model catalogs for subscription providers (#156, extended to the four
 * new OAuth providers in #164): the post-login model list the wizard shows.
 * Since ADR-0046 (#959) the data files are **generated** by moh's own
 * pipeline from declared aggregators (models.dev primary, OpenRouter
 * hole-filling) plus a hand-maintained `<provider>.overrides.json` sidecar —
 * see model-catalogs/README.md and
 * `packages/core/scripts/build-model-catalogs.ts`; this module flattens them
 * into a per-provider list.
 *
 * Deliberately read-only and static: no network fetch at runtime — the
 * catalog ships with the package and is versioned in the repo (issue #156
 * owner decision; #164 keeps one mechanism and one generation story for all
 * providers).
 *
 * #164 also turns the catalog into the per-model metadata source for
 * the #159 wire seam: `catalogEntryFor` gives the wire (pi api name
 * mapped to WireApi), per-model headers (copilot editor headers) and
 * compat flags the route attaches to its targets.
 */
import anthropicJson from "./model-catalogs/anthropic.json";
import openaiCodexJson from "./model-catalogs/openai-codex.json";
import googleJson from "./model-catalogs/google.json";
import githubCopilotJson from "./model-catalogs/github-copilot.json";
import openrouterJson from "./model-catalogs/openrouter.json";
import kimiCodingJson from "./model-catalogs/kimi-coding.json";
import xaiJson from "./model-catalogs/xai.json";
import zaiJson from "./model-catalogs/zai.json";
import deepseekJson from "./model-catalogs/deepseek.json";
import groqJson from "./model-catalogs/groq.json";
import cerebrasJson from "./model-catalogs/cerebras.json";
import nvidiaNimJson from "./model-catalogs/nvidia-nim.json";
import togetherJson from "./model-catalogs/together.json";
import fireworksJson from "./model-catalogs/fireworks.json";
import huggingfaceJson from "./model-catalogs/huggingface.json";
import mistralJson from "./model-catalogs/mistral.json";
import moonshotJson from "./model-catalogs/moonshot.json";
import minimaxJson from "./model-catalogs/minimax.json";
import qwenJson from "./model-catalogs/qwen.json";
import xiaomiMimoJson from "./model-catalogs/xiaomi-mimo.json";
import vercelAiGatewayJson from "./model-catalogs/vercel-ai-gateway.json";
import cloudflareAiGatewayJson from "./model-catalogs/cloudflare-ai-gateway.json";
import basetenJson from "./model-catalogs/baseten.json";
import opencodeZenJson from "./model-catalogs/opencode-zen.json";
import opencodeGoJson from "./model-catalogs/opencode-go.json";
import type { WireApi } from "./wire";
import type { ThinkingFormat, ThinkingLevel } from "./types";

/** One selectable model in a subscription catalog. */
export interface CatalogModel {
  /** The model id to persist as `defaultModel`. */
  id: string;
  /** Human label for the picker. */
  name: string;
  contextWindow: number;
  reasoning: boolean;
  /** #241: the model's thinking-level map, as the catalog declares it. Keys are level names (canonical moh ones plus any
   * provider-specific extras like "minimal"); a non-null value is the
   * provider-native expression, `null` is an explicit provider-native
   * disable. Absent = the model declares no level map: level selection
   * is not offered (#239 decision 10). */
  thinkingLevelMap?: Record<string, string | null>;
  /** Wire the backend speaks for this model (#159 seam; the pi api name
   * mapped to WireApi). Absent = the kind's default wire. */
  wire?: WireApi;
  /** Input modalities declared by the catalog (vision note 4): "image"
   * present = the model accepts image content blocks. Absent (openai-compat
   * and custom) = not image-capable — moh never invents capabilities. */
  input?: string[];
  /** Per-model headers (copilot editor headers). */
  headers?: Record<string, string>;
  /** Provider compat flags (e.g. kimi allowEmptySignature) — carried as
   * data; application is per-flag and lands with the flags that need it. */
  compat?: Record<string, unknown>;
  /** Approximate USD prices per million tokens for the endpoint's metered
   * billing plan (ADR-0046). Absent means pricing is unknown, never free. */
  pricing?: ModelPricing;
  /** ADR-0046 billing plan: the subscription-plan price record, when the
   * catalog declares one (the same model, sold by plan rather than per
   * token). Selected only when the endpoint declares `billingPlan:
   * "subscription"`; a zero-only record is plan-included, which the pricing
   * seam reads as "no marginal rate", never as free. */
  planPricing?: ModelPricing;
}

/** Approximate USD prices per million tokens. Zero is an explicit free rate;
 * absent pricing is unknown. Tiers replace all rates once the input-token
 * count of an individual call reaches `inputTokensAbove`. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: Array<ModelPricingTier>;
}

export interface ModelPricingTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** A catalog file's shape: `{ <api>: { <modelId>: row } }` — the wire is the
 * outer key, which is how a provider that speaks several wires per model
 * (copilot, OpenCode) files its rows. */
type CatalogFile = Record<string, Record<string, CatalogRow>>;
interface CatalogRow {
  id: string;
  baseUrl?: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  cost?: ModelPricing;
  /** ADR-0046 billing plan: the subscription-plan price entry. */
  planCost?: ModelPricing;
}

/** The wire names the catalog files use → moh wires. Unknown apis are
 * skipped (not guessed). */
export const PI_API_TO_WIRE: Record<string, WireApi> = {
  "anthropic-messages": "anthropic-messages",
  "openai-completions": "openai-chat",
  "openai-responses": "openai-responses",
  // #156-era files use their own api names for the same wires.
  "openai-codex-responses": "openai-responses",
  "google-generative-ai": "google",
};

/** #256 minimal normalization: a provider-native `minimal` key counts as
 * the canonical `low` (native value preserved) only when the map does not
 * also carry `low`; when both are present `low` wins and `minimal` is
 * dropped. This is data normalization of declared capabilities at the
 * projection — not the runtime remapping spec decision 8 forbids. */
export function normalizeThinkingLevelMap(map: Record<string, string | null>): Record<string, string | null> {
  if (!("minimal" in map)) return map;
  const { minimal: _minimal, ...rest } = map;
  if (rest.low === undefined) rest.low = _minimal;
  return rest;
}

function toModel(entry: CatalogRow, api: string): CatalogModel | undefined {
  const wire = PI_API_TO_WIRE[api];
  if (!wire) return undefined;
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    contextWindow: entry.contextWindow ?? 0,
    reasoning: entry.reasoning ?? false,
    wire,
    ...(entry.thinkingLevelMap ? { thinkingLevelMap: normalizeThinkingLevelMap(entry.thinkingLevelMap) } : {}),
    ...(entry.input ? { input: entry.input } : {}),
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.compat ? { compat: entry.compat } : {}),
    ...(entry.cost ? { pricing: entry.cost } : {}),
    ...(entry.planCost ? { planPricing: entry.planCost } : {}),
  };
}

/** The picker list: deduped by id, first api wins (file order is the
 * provider's own preference — e.g. copilot lists anthropic-messages
 * first). */
function collect(catalog: CatalogFile): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const [api, models] of Object.entries(catalog)) {
    for (const entry of Object.values(models)) {
      if (seen.has(entry.id)) continue;
      const model = toModel(entry, api);
      if (!model) continue;
      seen.add(entry.id);
      out.push(model);
    }
  }
  return out;
}

const CATALOGS = {
  anthropic: collect(anthropicJson),
  openai: collect(openaiCodexJson),
  google: collect(googleJson),
  "github-copilot": collect(githubCopilotJson),
  openrouter: collect(openrouterJson),
  "kimi-coding": collect(kimiCodingJson),
  xai: collect(xaiJson),
  zai: collect(zaiJson),
  deepseek: collect(deepseekJson), groq: collect(groqJson), cerebras: collect(cerebrasJson), "nvidia-nim": collect(nvidiaNimJson),
  together: collect(togetherJson), fireworks: collect(fireworksJson), huggingface: collect(huggingfaceJson), mistral: collect(mistralJson),
  moonshot: collect(moonshotJson), minimax: collect(minimaxJson), qwen: collect(qwenJson), "xiaomi-mimo": collect(xiaomiMimoJson),
  "vercel-ai-gateway": collect(vercelAiGatewayJson), "cloudflare-ai-gateway": collect(cloudflareAiGatewayJson), baseten: collect(basetenJson),
  "opencode-zen": collect(opencodeZenJson),
  "opencode-go": collect(opencodeGoJson),
  opencode: collect(opencodeZenJson),
} as const satisfies Record<string, CatalogModel[]>;

/** Providers that have a shipped subscription catalog. */
export type CatalogProviderType = keyof typeof CATALOGS;

/** Every api key present in the shipped files — a generation check: an
 * unmapped wire name must fail loudly here, not silently drop models from
 * the picker. */
export function catalogApiNames(): string[] {
  return [
    ...Object.keys(anthropicJson),
    ...Object.keys(openaiCodexJson),
    ...Object.keys(googleJson),
    ...Object.keys(githubCopilotJson),
    ...Object.keys(openrouterJson),
    ...Object.keys(kimiCodingJson),
    ...Object.keys(xaiJson),
    ...Object.keys(zaiJson),
  ].filter((api, i, all) => all.indexOf(api) === i);
}

/** The baseUrl values the shipped data declares, per provider — drift
 * check against OAUTH_BUILTIN_BASE_URLS (the registry's own source). */
export function catalogBaseUrls(type: string): Set<string> {
  const files: Record<string, CatalogFile> = {
    anthropic: anthropicJson,
    openai: openaiCodexJson,
    google: googleJson,
    "github-copilot": githubCopilotJson,
    openrouter: openrouterJson,
    "kimi-coding": kimiCodingJson,
    xai: xaiJson,
    zai: zaiJson,
  };
  const file = files[type] ?? {};
  return new Set(Object.values(file).flatMap((models) => Object.values(models).map((e) => e.baseUrl).filter((b): b is string => typeof b === "string")));
}

/**
 * The post-login model list for a subscription provider. Unknown types
 * (openai-compat, custom) get an empty list — the wizard falls back to
 * free-text entry (acceptance: subscription onboarding never *requires*
 * the list, but never requires typing when one exists).
 */
export function subscriptionModelCatalog(type: string): CatalogModel[] {
  return (CATALOGS as Record<string, CatalogModel[]>)[type] ?? [];
}

/** Metadata that moh can safely attach while onboarding a recognized
 * openai-compat host. It is deliberately data-only: no provider runtime is
 * added for that host. */
export interface KnownCompatEndpointMetadata {
  catalog: CatalogProviderType;
  thinking: { format: ThinkingFormat; levels: ThinkingLevel[] };
}

/** Recognizes compat hosts with shipped model metadata. Keeping recognition
 * here makes picker metadata and onboarding capabilities one coherent
 * contract. Both Z.ai API paths deliberately match by hostname. */
export function knownCompatEndpointMetadata(baseUrl?: string): KnownCompatEndpointMetadata | undefined {
  try {
    if (baseUrl && new URL(baseUrl).hostname.toLowerCase() === "api.z.ai") {
      return {
        catalog: "zai",
        thinking: { format: "openai-effort", levels: ["off", "low", "high", "max"] },
      };
    }
  } catch {
    // Invalid/custom URLs remain unrecognized; config validation owns errors.
  }
  return undefined;
}

/** Catalog for one configured endpoint. Most endpoints resolve directly by
 * type; recognized openai-compat hosts opt into shipped metadata without
 * becoming provider implementations. */
export function endpointModelCatalog(type: string, baseUrl?: string): CatalogModel[] {
  if (type === "opencode") return subscriptionModelCatalog(baseUrl?.replace(/\/$/, "") === "https://opencode.ai/zen/go/v1" ? "opencode-go" : "opencode-zen");
  if (type !== "openai-compat") return subscriptionModelCatalog(type);
  const metadata = knownCompatEndpointMetadata(baseUrl);
  return metadata ? subscriptionModelCatalog(metadata.catalog) : [];
}

/**
 * The catalog entry for one model id (#164): the wire/headers/compat a
 * route target attaches. First matching api wins, matching the picker's
 * dedupe order. Absent entry = use the kind's default wire.
 */
export function catalogEntryFor(type: string, modelId: string, baseUrl?: string): CatalogModel | undefined {
  // OpenCode's wire is per model and differs per product (Zen vs Go) with
  // the same ids — resolve through the endpoint's own overlay.
  if (type === "opencode") return endpointModelCatalog("opencode", baseUrl).find((m) => m.id === modelId);
  return subscriptionModelCatalog(type).find((m) => m.id === modelId);
}

/** The billing plan an endpoint pays by (ADR-0046): a metered API key or a
 * subscription plan. The endpoint declares it; moh never infers it from a
 * model name. */
export type BillingPlan = "metered" | "subscription";

/** The price entry a billing plan selects on one catalog row. The metered
 * entry is the default; `subscription` uses the declared plan record when
 * the row has one, and falls back to the metered entry when it does not. */
export function pricingForPlan(entry: CatalogModel, plan: BillingPlan = "metered"): ModelPricing | undefined {
  if (plan === "subscription") return entry.planPricing ?? entry.pricing;
  return entry.pricing;
}

/** Two price records describe the same rates. Cache rates absent and zero
 * are the same price; a tier is a refinement of the same schedule, not a
 * conflicting one — otherwise a catalog-less endpoint would lose every
 * estimate for an id two catalogs both price, purely because one of them
 * refines the rates past a context boundary. The base rates decide. */
function sameRates(a: ModelPricing, b: ModelPricing): boolean {
  const base = (pricing: ModelPricing) => [pricing.input, pricing.output, pricing.cacheRead ?? 0, pricing.cacheWrite ?? 0];
  return JSON.stringify(base(a)) === JSON.stringify(base(b));
}

/** Finds unambiguous pricing by model id across the shipped catalogs, for
 * the endpoint's billing plan. Event logs retain an endpoint name rather
 * than its profile type, so a collision with different prices is
 * deliberately unavailable instead of guessed. */
export function pricingForModel(model: string, plan: BillingPlan = "metered"): ModelPricing | undefined {
  const slash = model.indexOf("/");
  const endpoint = slash === -1 ? undefined : model.slice(0, slash);
  const modelId = slash === -1 ? model : model.slice(slash + 1);

  // An endpoint whose name is one moh ships a catalog for has its own
  // authoritative list, and the endpoint prefix is material: the ids Zen and
  // Go share with the upstream vendors must resolve to *their* rate, and an
  // id their list does not carry stays unpriced rather than borrowing a
  // coincidentally matching third-party record.
  const own = endpoint ? (CATALOGS as Record<string, CatalogModel[]>)[endpoint] : undefined;
  if (own) {
    const pricing = pricingForPlan(own.find((entry) => entry.id === modelId) ?? { id: modelId, name: modelId, contextWindow: 0, reasoning: false }, plan);
    return pricing && (pricing.input > 0 || pricing.output > 0) ? pricing : undefined;
  }

  // Event logs record `endpoint/model-id`; OpenRouter model ids themselves
  // contain `/`. Prefer an exact catalog id after removing one endpoint
  // segment, then fall back to a bare id only when catalog rates agree.
  const all = Object.values(CATALOGS).flat();
  const exact = all.filter((entry) => entry.id === modelId);
  const candidates = exact.length > 0 ? exact : all.filter((entry) => entry.id === model || entry.id === modelId);
  const matches = candidates
    .map((entry) => pricingForPlan(entry, plan))
    // Zero-only records in minimal endpoint catalogs are placeholders, not
    // evidence of a free model. Conservatively leave them tokens-only.
    .filter((pricing): pricing is ModelPricing => pricing !== undefined && (pricing.input > 0 || pricing.output > 0));
  if (matches.length === 0) return undefined;
  const first = matches[0]!;
  return matches.every((pricing) => sameRates(pricing, first)) ? first : undefined;
}

/**
 * Whether one model accepts image content blocks (vision note 4). Declared
 * capability only, never inferred: a catalog entry carrying "image" in its
 * input modalities is image-capable; every model WITHOUT a catalog entry
 * (openai-compat, custom) is image-capable only when the endpoint declares
 * it explicitly (`capabilities.multimodal: true` — mirroring
 * `capabilities.thinking` for thinking); catalog-backed models without the
 * modality are not, and `capabilities.multimodal: false` overrides the
 * catalog. The caller warns visibly and sends the text chip instead.
 */
export function modelSupportsImages(
  model: CatalogModel | undefined,
  capabilities?: { multimodal?: boolean },
): boolean {
  if (capabilities?.multimodal === false) return false;
  if (model) return model.input?.includes("image") ?? false;
  // No catalog entry: the capability comes from the endpoint declaration
  // alone — moh never invents it.
  return capabilities?.multimodal === true;
}
