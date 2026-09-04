/**
 * Vendored model catalogs for subscription providers (#156, extended to
 * the four new OAuth providers in #164): the post-login model list the
 * wizard shows. Data files are verbatim copies of pi-ai's
 * auto-generated catalogs (MIT — see model-catalogs/README.md for
 * attribution and the regeneration script); this module flattens them
 * into a per-provider list.
 *
 * Deliberately read-only and static: no pi-ai runtime dependency, no
 * network fetch — the catalog ships with the package and is versioned
 * in the repo (issue #156 owner decision; #164 keeps one mechanism and
 * one regeneration story for all providers, openrouter's 346-model list
 * included).
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
  /** #241: the model's thinking-level map, preserved verbatim from the
   * vendored catalog. Keys are level names (canonical moh ones plus any
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
}

/** The pi-ai catalog shape: `{ <api>: { <modelId>: entry } }`. */
type PiAiCatalog = Record<string, Record<string, PiAiEntry>>;
interface PiAiEntry {
  id: string;
  baseUrl?: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

/** pi api names → moh wires. Unknown apis are skipped (not guessed). */
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

function toModel(entry: PiAiEntry, api: string): CatalogModel | undefined {
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
  };
}

/** The picker list: deduped by id, first api wins (file order is the
 * provider's own preference — e.g. copilot lists anthropic-messages
 * first). */
function collect(catalog: PiAiCatalog): CatalogModel[] {
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
} as const satisfies Record<string, CatalogModel[]>;

/** Providers that have a vendored subscription catalog. */
export type CatalogProviderType = keyof typeof CATALOGS;

/** Every api key present in the vendored files — a regen check: an
 * unmapped pi api name must fail loudly here, not silently drop models
 * from the picker. */
export function vendoredApiNames(): string[] {
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

/** The baseUrl values the vendored data declares, per provider — drift
 * check against OAUTH_BUILTIN_BASE_URLS (the registry's own source). */
export function vendoredBaseUrls(type: string): Set<string> {
  const files: Record<string, PiAiCatalog> = {
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
 * type; recognized openai-compat hosts opt into vendored metadata without
 * becoming provider implementations. */
export function endpointModelCatalog(type: string, baseUrl?: string): CatalogModel[] {
  if (type !== "openai-compat") return subscriptionModelCatalog(type);
  const metadata = knownCompatEndpointMetadata(baseUrl);
  return metadata ? subscriptionModelCatalog(metadata.catalog) : [];
}

/**
 * The catalog entry for one model id (#164): the wire/headers/compat a
 * route target attaches. First matching api wins, matching the picker's
 * dedupe order. Absent entry = use the kind's default wire.
 */
export function catalogEntryFor(type: string, modelId: string): CatalogModel | undefined {
  return subscriptionModelCatalog(type).find((m) => m.id === modelId);
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
