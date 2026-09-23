/**
 * Live model-list adapters for catalog-backed providers (#551, extended
 * by the #920 coverage audit): one verified contract per provider — no
 * guessing. The vendored subscription catalogs (#156/#164, regenerated
 * from pi-ai) stay the metadata source of truth; a live listing only
 * *adds* models the vendored file does not yet carry, so newly released
 * models appear without a moh release.
 *
 * Every contract below was probed against the provider itself (#920):
 * the route exists, and the shape is the standard
 * `{object: "list", data: [{id}]}` unless the docblock says otherwise.
 * Coverage is the whole catalog moh ships, not a hand-picked subset —
 * the fifteen `openai-completions` profiles of #726 carry a single
 * vendored model each, so their listing IS their update story.
 *
 * Per-provider contracts:
 *  - openai (ChatGPT/Codex backend): `models[].slug`, `originator` +
 *    `client_version` (required, and a version gate — see
 *    `CODEX_LISTING_CLIENT_VERSION`); only `visibility: "list"` +
 *    `supported_in_api`.
 *  - anthropic: `GET /v1/models`, paginated (`has_more`/`after_id`),
 *    `max_input_tokens`.
 *  - google: `GET /v1beta/models`, paginated (`nextPageToken`),
 *    `generateContent` filter.
 *  - openrouter: public `GET /api/v1/models`, complete list.
 *  - xai / github-copilot: OpenAI-like `data[].id` (copilot needs its
 *    full editor-header client profile).
 *  - kimi-coding: the coding backend's list lives at `/coding/v1/models`
 *    (a probe of `/coding/models` is what made it look absent), and
 *    answers the OpenAI-like shape.
 *  - opencode (Zen/Go): the product's own `/models` snapshot, ids only.
 *  - the #726 profiles (zai, deepseek, groq, …): documented
 *    `<baseUrl>/models`, the OpenAI-compatible listing route.
 *  - baseten: NO verified listing route — its `/v1/models` is served by
 *    the website (403, marketing CSP), not by an inference API.
 *    Deliberately static: the regen-from-pi-ai path is its update story.
 *
 * Failures are silent degradation; fetched-only entries carry
 * conservative metadata (moh never invents capabilities).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";import type { CatalogModel } from "./model-catalog";
import { subscriptionModelCatalog } from "./model-catalog";
import { providerProfile } from "./provider-profiles";
import { OAUTH_BUILTIN_BASE_URLS } from "./wire";
import { CHATGPT_CODEX_BASE_URL, CHATGPT_CODEX_ORIGINATOR } from "./auth/openai";
import { readAuthSection, getStoredApiKey } from "./auth/store";
import { readUserConfigFile, userConfigFile } from "./user-config";

/** One model as the provider's listing exposes it. */
export interface LiveModelListing {
  id: string;
  name?: string;
  contextWindow?: number;
  /** `priority`-style ordering hint (Codex); lower = more prominent. */
  priority?: number;
}

/** Injectable fetch seam (tests). */
export type ListingFetch = (url: string, headers: Record<string, string>) => Promise<{ status: number; json: unknown }>;

/**
 * The `client_version` the Codex backend requires on its model listing.
 * It is not cosmetic: the backend gates every model on its own
 * `minimal_client_version <= client_version`, and moh's release version
 * is not a Codex CLI version. Probed values (#920):
 * `0.46.0` (moh's own) → an EMPTY list, `0.0.0` → the 0.153-era list
 * (hiding `gpt-6-sol`/`gpt-6-luna`, min 0.155.0), `1.0.0`+ → the full
 * list. A saturating version therefore asks for the widest list the
 * account may use — the same client-impersonation posture as
 * `CHATGPT_CODEX_ORIGINATOR`.
 */
export const CODEX_LISTING_CLIENT_VERSION = "999.0.0";

// ── per-contract parsers ─────────────────────────────────────────────────

/**
 * A parser reads one page of a provider's listing. `undefined` means the
 * body is not this contract's shape; an empty array means the shape is
 * right and the list is empty — a distinction the caller needs, because
 * an empty list is how a version gate and an account with no access both
 * present themselves (a failure, never a valid answer).
 */
type Parser = (body: unknown) => LiveModelListing[] | undefined;

/** OpenAI-like `{ data: [{ id, … }] }` (most providers, xai, copilot). */
const parseOpenAiData: Parser = (body) => {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return undefined;
  const out: LiveModelListing[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || !id) continue;
    // `display_name` is the OpenAI-compatible convention, `name` the one
    // OpenRouter and Mistral use — both are the listing's own label.
    const label = typeof e.display_name === "string" && e.display_name ? e.display_name : typeof e.name === "string" && e.name ? e.name : undefined;
    const ctx = typeof e.context_length === "number" ? e.context_length : typeof e.max_context_length === "number" ? e.max_context_length : undefined;
    out.push({
      id,
      ...(label ? { name: label } : {}),
      ...(ctx !== undefined ? { contextWindow: ctx } : {}),
    });
  }
  return out;
};

/** ChatGPT/Codex backend `{ models: [{ slug, … }] }` (upstream
 * `ModelsResponse`/`ModelInfo`). Only picker-visible, API-supported
 * models become rows; `visibility`/`supported_in_api` gate the rest. */
const parseCodexModels: Parser = (body) => {
  if (typeof body !== "object" || body === null) return undefined;
  const models = (body as Record<string, unknown>).models;
  if (!Array.isArray(models)) return undefined;
  const out: LiveModelListing[] = [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.slug !== "string" || !e.slug) continue;
    if (e.visibility !== undefined && e.visibility !== "list") continue;
    if (e.supported_in_api === false) continue;
    const priority = typeof e.priority === "number" ? e.priority : undefined;
    out.push({
      id: e.slug,
      ...(typeof e.display_name === "string" && e.display_name ? { name: e.display_name } : {}),
      ...(typeof e.context_window === "number" ? { contextWindow: e.context_window } : {}),
      ...(priority !== undefined ? { priority } : {}),
    });
  }
  return out;
};

/** Anthropic `{ data: [...], has_more, last_id }`. */
const parseAnthropicModels: Parser = (body) => parseOpenAiData(body);

/** Google `{ models: [{ name: "models/x", … }], nextPageToken }`. */
const parseGoogleModels: Parser = (body) => {
  if (typeof body !== "object" || body === null) return undefined;
  const models = (body as Record<string, unknown>).models;
  if (!Array.isArray(models)) return undefined;
  const out: LiveModelListing[] = [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name) continue;
    const methods = Array.isArray(e.supportedGenerationMethods) ? e.supportedGenerationMethods : undefined;
    if (methods && !methods.includes("generateContent")) continue;
    const id = e.name.startsWith("models/") ? e.name.slice("models/".length) : e.name;
    if (!id) continue;
    out.push({
      id,
      ...(typeof e.displayName === "string" && e.displayName ? { name: e.displayName } : {}),
      ...(typeof e.inputTokenLimit === "number" ? { contextWindow: e.inputTokenLimit } : {}),
    });
  }
  return out;
};

/** Legacy union parser kept for compatibility with the #555 tests:
 * tries Codex, then Google, then OpenAI-like. The first parser to find a
 * model wins; a body at least one of them recognized as its own shape
 * (but carrying no model) is a valid empty list, anything else is
 * unrecognized. */
export function parseModelsResponse(body: unknown): LiveModelListing[] | undefined {
  const candidates = [parseCodexModels(body), parseGoogleModels(body), parseOpenAiData(body)];
  const firstNonEmpty = candidates.find((c) => c !== undefined && c.length > 0);
  if (firstNonEmpty) return firstNonEmpty;
  return candidates.some((c) => c !== undefined) ? [] : undefined;
}

// ── the contract table ───────────────────────────────────────────────────

/**
 * One provider's verified live-listing contract. Adding a provider is one
 * row here; the route is never guessed.
 */
interface ListingContract {
  /** Base URL when it is not the endpoint's own (Codex backend, OpenCode
   * products — whose base is a property of the endpoint name). */
  base?: (endpointName: string) => string | undefined;
  parser: Parser;
  /** URL templates: the first is page 1, later ones continue it
   * (`{last}`/`{token}` are filled by the page loop). Default:
   * `<base>/models`. */
  urls?: (base: string, clientVersion: string) => string[];
  /** Where the credential goes. Default: `Authorization: Bearer`. */
  headers?: (credential: string | undefined) => Record<string, string>;
}

const ACCEPT = { Accept: "application/json" };

/** One auth mode per request: API-key headers and OAuth bearer are never
 * mixed. Each helper also works credential-less (a public listing, or a
 * failed lookup that must surface as the provider's own 401). */
const bearer = (credential?: string) => ({ ...ACCEPT, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) });
const anthropicHeaders = (credential?: string) => ({ ...ACCEPT, "anthropic-version": "2023-06-01", ...(credential ? { "x-api-key": credential } : {}) });
const googleHeaders = (credential?: string) => ({ ...ACCEPT, ...(credential ? { "x-goog-api-key": credential } : {}) });
/** The Copilot client profile (same headers the vendored catalog attaches
 * per model). */
const copilotHeaders = (credential?: string) => ({
  ...ACCEPT,
  ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.95.0",
  "Editor-Plugin-Version": "copilot-chat/0.26.0",
  "User-Agent": "GitHubCopilotChat/0.26.0",
});
/** The ChatGPT-backend contract: the Codex CLI originator identifies the
 * client (moh speaks the same backend via #151). */
const codexHeaders = (credential?: string) => ({ ...ACCEPT, ...(credential ? { Authorization: `Bearer ${credential}` } : {}), originator: CHATGPT_CODEX_ORIGINATOR });

/**
 * The #726 provider profiles whose OpenAI-compatible `<baseUrl>/models`
 * route was probed and answers the `data[].id` shape (#920). One row of
 * code, not fifteen: the base URL is the profile's documented default,
 * or the endpoint's own configured URL.
 */
const OPENAI_LISTING_PROFILES = [
  "zai",
  "deepseek",
  "groq",
  "cerebras",
  "nvidia-nim",
  "together",
  "fireworks",
  "huggingface",
  "mistral",
  "moonshot",
  "minimax",
  "qwen",
  "xiaomi-mimo",
  "vercel-ai-gateway",
  "cloudflare-ai-gateway",
] as const;

/** OAuth providers whose base URL is a protocol constant rather than a
 * provider profile (#726 profiles carry their own documented default). */
const OAUTH_LISTING_BASES: Record<string, string | undefined> = OAUTH_BUILTIN_BASE_URLS;

const CONTRACTS: Record<string, ListingContract> = {
  anthropic: {
    base: () => "https://api.anthropic.com/v1",
    parser: parseAnthropicModels,
    headers: anthropicHeaders,
    urls: (base) => [`${base}/models?limit=1000`, `${base}/models?limit=1000&after_id={last}`],
  },
  openai: {
    base: () => CHATGPT_CODEX_BASE_URL,
    parser: parseCodexModels,
    headers: codexHeaders,
    urls: (base, clientVersion) => [`${base}/models?client_version=${encodeURIComponent(clientVersion)}`],
  },
  google: {
    base: () => "https://generativelanguage.googleapis.com/v1beta",
    parser: parseGoogleModels,
    headers: googleHeaders,
    urls: (base) => [`${base}/models?pageSize=1000`, `${base}/models?pageSize=1000&pageToken={token}`],
  },
  "github-copilot": { base: () => OAUTH_LISTING_BASES["github-copilot"], parser: parseOpenAiData, headers: copilotHeaders },
  openrouter: { base: () => OAUTH_LISTING_BASES.openrouter, parser: parseOpenAiData },
  xai: { base: () => OAUTH_LISTING_BASES.xai, parser: parseOpenAiData },
  // The coding backend's list sits under /v1 (probed #920).
  "kimi-coding": { base: () => OAUTH_LISTING_BASES["kimi-coding"], parser: parseOpenAiData, urls: (base) => [`${base}/v1/models`] },
  opencode: { base: opencodeBaseUrl, parser: parseOpenAiData },
};
for (const id of OPENAI_LISTING_PROFILES) CONTRACTS[id] = { parser: parseOpenAiData };

/** True when the kind has a vendored catalog worth augmenting. */
export function hasVendoredCatalog(type: string): boolean {
  return subscriptionModelCatalog(type).length > 0;
}

/**
 * True when the kind has a verified live-listing contract (#920). The
 * clients never ask: they call `fetchLiveCatalogs`, which applies this
 * itself. Exported from the defining module (ADR-0004) for the coverage
 * guard in the tests — a provider must not go silently static.
 */
export function hasLiveListingContract(type: string): boolean {
  return CONTRACTS[type] !== undefined;
}

/**
 * The base URL a listing call uses, most specific first: the endpoint's
 * own configured baseUrl (a proxy, a regional alternative), the
 * contract's protocol constant (Codex backend, OpenCode products,
 * Anthropic/Google/xAI/Copilot/Kimi), then the provider profile's
 * documented default (#726).
 */
function listingBase(kind: string, endpointName: string, endpointBaseUrl: string | undefined): string | undefined {
  const contract = CONTRACTS[kind];
  if (!contract) return undefined;
  return endpointBaseUrl ?? contract.base?.(endpointName) ?? providerProfile(kind)?.baseUrl;
}


/** The credential a listing call needs, read-only from the stores: the
 * profile's inline key, its env var, the wizard-stored api key, or —
 * for subscription endpoints — the stored access token *without* the
 * proactive refresh (a background picker fetch never mutates the auth
 * store; a stale token degrades to the static list, same as an error). */
function listingCredential(kind: string, endpointName: string, inlineApiKey: string | undefined, configFile: string): string | undefined {
  if (inlineApiKey) return inlineApiKey;
  const section = readAuthSection(configFile);
  const token = section.tokens[endpointName];
  if (token?.accessToken) return token.accessToken;
  return getStoredApiKey(configFile, endpointName);
}

/** Page loop limits (bounded, never unbounded). */
const MAX_PAGES = 5;

/**
 * Fetches one provider's live model list with its verified contract.
 * Throws on any failure — the orchestrator degrades; direct callers
 * should too.
 */
export async function listProviderModels(
  kind: string,
  endpointName: string,
  opts: { baseUrl?: string; apiKey?: string; configFile?: string; fetchImpl?: ListingFetch; signal?: AbortSignal; clientVersion?: string } = {},
): Promise<LiveModelListing[]> {
  const contract = CONTRACTS[kind];
  const base = listingBase(kind, endpointName, opts.baseUrl);
  if (!base || !contract) throw new Error(`no verified model listing contract for provider kind "${kind}"`);
  const clientVersion = opts.clientVersion ?? CODEX_LISTING_CLIENT_VERSION;
  const credential = listingCredential(kind, endpointName, opts.apiKey, opts.configFile ?? userConfigFile());
  const templates = contract.urls?.(base, clientVersion) ?? [`${base}/models`];
  const headers = contract.headers?.(credential) ?? bearer(credential);
  const doFetch = opts.fetchImpl ?? (async (u, h) => {
    const res = await fetch(u, { headers: h, signal: opts.signal ?? AbortSignal.timeout(10_000) });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  });

  const out: LiveModelListing[] = [];
  const seen = new Set<string>();
  // Page loop: first template, then continuation templates until no
  // next-page marker or the page cap — bounded, provider-shaped. The
  // loop body is self-contained (no shared module state).
  let pageBody: unknown;
  for (let page = 0; page < MAX_PAGES; page++) {
    const template = templates[Math.min(page, templates.length - 1)]!;
    const url = template
      .replace("{last}", out.at(-1)?.id ?? "")
      .replace("{token}", nextToken(kind, pageBody));
    const { status, json } = await doFetch(url, headers);
    if (status < 200 || status >= 300) throw new Error(`${url} → HTTP ${status}`);
    const parsed = contract.parser(json);
    if (parsed === undefined) {
      if (out.length === 0) throw new Error(`${url} → unrecognized model list shape`);
      break;
    }
    // A well-formed but empty list is a failure, never a valid answer: it
    // is how a version gate (Codex `client_version`) and an account with
    // no access both present themselves. Degrading to the cache beats
    // silently serving nothing.
    if (parsed.length === 0) {
      if (out.length === 0) throw new Error(`${url} → empty model list`);
      break;
    }
    for (const m of parsed) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    pageBody = json;
    if (!hasNextPage(kind, json)) break;
  }
  return out;
}


function opencodeBaseUrl(endpointName: string): string | undefined {
  if (endpointName === "opencode-zen") return "https://opencode.ai/zen/v1";
  if (endpointName === "opencode-go") return "https://opencode.ai/zen/go/v1";
  return undefined;
}

function hasNextPage(kind: string, body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (kind === "anthropic") return b.has_more === true;
  if (kind === "google") return typeof b.nextPageToken === "string" && b.nextPageToken.length > 0;
  return false;
}

function nextToken(kind: string, body: unknown): string {
  if (kind !== "google" || typeof body !== "object" || body === null) return "";
  const token = (body as Record<string, unknown>).nextPageToken;
  return typeof token === "string" ? token : "";
}

/** Vendored entries win on id collision; fetched-only entries become
 * conservative picker rows, enriched where the listing offered data. */
export function mergeLiveCatalog(vendored: CatalogModel[], live: LiveModelListing[]): CatalogModel[] {
  const extra = live
    .slice()
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .filter((m) => !vendored.some((v) => v.id === m.id));
  const augmented: CatalogModel[] = extra.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? 0,
    reasoning: false,
  }));
  return [...vendored, ...augmented];
}

// ── user config (`~/.moh/config`, `liveModels` section) ─────────────────

export interface LiveModelsConfig {
  /** Default true. `false` restores fully static behavior. */
  enabled?: boolean;
  /** Cache TTL in hours. Default 24. */
  ttlHours?: number;
}

const DEFAULT_TTL_HOURS = 24;

export function readLiveModelsConfig(home?: string): LiveModelsConfig {
  const section = readUserConfigFile(userConfigFile(home)).liveModels as LiveModelsConfig | undefined;
  if (typeof section !== "object" || section === null) return {};
  return {
    ...(typeof section.enabled === "boolean" ? { enabled: section.enabled } : {}),
    ...(typeof section.ttlHours === "number" && section.ttlHours >= 0 ? { ttlHours: section.ttlHours } : {}),
  };
}

// ── disk cache (`~/.moh/live-models.json`) ──────────────────────────────

export interface LiveModelCacheEntry {
  fetchedAt: number;
  models: LiveModelListing[];
}

export function liveModelCacheFile(home?: string): string {
  return join(home ?? homedir(), ".moh", "live-models.json");
}

/** Cache entries keyed by endpoint name; missing/corrupt file = empty. */
export async function loadLiveModelCache(file: string = liveModelCacheFile()): Promise<Record<string, LiveModelCacheEntry>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, LiveModelCacheEntry> = {};
    for (const [endpoint, entry] of Object.entries(parsed)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.fetchedAt !== "number" || !Array.isArray(e.models)) continue;
      const models = e.models.filter(
        (m): m is LiveModelListing => typeof m === "object" && m !== null && typeof (m as LiveModelListing).id === "string",
      );
      out[endpoint] = { fetchedAt: e.fetchedAt, models };
    }
    return out;
  } catch {
    return {};
  }
}

/** Persists entries through a read-modify-write of the whole cache file. */
export async function saveLiveModelCache(entries: Record<string, LiveModelCacheEntry>, file: string = liveModelCacheFile()): Promise<void> {
  const current = await loadLiveModelCache(file);
  const merged = { ...current, ...entries };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}

/** Entries whose cache age is within the TTL. Expired entries are
 * dropped from this projection but kept on disk — the orchestrator
 * falls back to them when a refresh fails (offline). */
export function freshCacheEntries(
  cache: Record<string, LiveModelCacheEntry>,
  ttlHours: number = DEFAULT_TTL_HOURS,
  now: number = Date.now(),
): Record<string, LiveModelListing[]> {
  const ttlMs = ttlHours * 3_600_000;
  const out: Record<string, LiveModelListing[]> = {};
  for (const [endpoint, entry] of Object.entries(cache)) {
    if (now - entry.fetchedAt <= ttlMs) out[endpoint] = entry.models;
  }
  return out;
}

export interface FetchLiveCatalogsOptions {
  mohHome?: string;
  configFile?: string;
  cacheFile?: string;
  fetchImpl?: ListingFetch;
  now?: number;
  /** Force a network refresh even when the cache is fresh. */
  force?: boolean;
  /** Client version advertised to contracts that want one (Codex). */
  clientVersion?: string;
}

/**
 * What happened to one endpoint's listing (ADR-0045). The distinction the
 * old bare projection could not carry: a list you are seeing is one of
 * these five things, and only the first is a refresh you just performed.
 */
export type LiveCatalogStatus =
  /** The provider answered this run; a fresh cache entry was written. */
  | { kind: "fresh" }
  /** A cache entry within its TTL; no network call was made. This is the
   * healthy steady state of a normal startup, never a degradation. */
  | { kind: "cached"; ageHours: number }
  /** The refresh failed and an expired cache entry was served instead,
   * with the age of that entry. */
  | { kind: "stale"; ageHours: number }
  /** The refresh failed and there is nothing to serve; `reason` is kept
   * for the caller to explain it (never rendered verbatim). */
  | { kind: "failed"; reason: string }
  /** This provider kind has no verified listing contract, so the vendored
   * catalog *is* its answer. Static by design, never a fault. */
  | { kind: "unsupported" };

/** One endpoint's outcome: the status, plus the listing it is a status of. */
export interface LiveCatalogResult {
  /** Live-only models to overlay on the vendored catalog (empty for
   * `failed` and `unsupported`). */
  models: LiveModelListing[];
  status: LiveCatalogStatus;
  /** The provider kind, carried so a client can ask whether a vendored
   * catalog backstops this endpoint without a second config lookup. */
  type: string;
}

export type LiveCatalogReport = Record<string, LiveCatalogResult>;

/** The live listings of a report, in the shape the pickers consumed
 * before the status existed (#551's projection, derived). */
export function liveListings(report: LiveCatalogReport): Record<string, LiveModelListing[]> {
  const out: Record<string, LiveModelListing[]> = {};
  for (const [endpoint, result] of Object.entries(report)) {
    if (result.models.length > 0) out[endpoint] = result.models;
  }
  return out;
}

function hoursSince(fetchedAt: number, now: number): number {
  return Math.max(0, Math.round(((now - fetchedAt) / 3_600_000) * 10) / 10);
}

/**
 * One line describing a report — the shared vocabulary for client
 * surfaces, so the picker and Settings cannot disagree about what
 * happened. The `failed` reason is deliberately NOT inlined: it is a
 * diagnostic for callers, and a summary is user-facing copy. Returns
 * `null` when the report is empty (nothing was asked).
 */
export function summarizeLiveCatalogReport(report: LiveCatalogReport): string | null {
  const entries = Object.entries(report);
  if (entries.length === 0) return null;
  const parts = entries.map(([endpoint, { status }]) => {
    switch (status.kind) {
      case "fresh": return `${endpoint} refreshed`;
      case "cached": return `${endpoint} cached (${status.ageHours}h)`;
      case "stale": return `${endpoint} stale (${status.ageHours}h, refresh failed)`;
      case "failed": return `${endpoint} unavailable`;
      case "unsupported": return `${endpoint} static (no listing route)`;
    }
  });
  return parts.join(" · ");
}

/** The diagnostic behind a `failed` status, for a log line or a
 * diagnostic surface — never for user-facing copy. */
export function liveCatalogFailureReasons(report: LiveCatalogReport): string[] {
  return Object.values(report)
    .filter((result): result is LiveCatalogResult & { status: { kind: "failed"; reason: string } } => result.status.kind === "failed")
    .map(({ status }) => `model listing unavailable: ${status.reason}`);
}

/**
 * Whether a report leaves the user with a usable list without outside
 * help (ADR-0045's context rule). The question is never "did a refresh
 * fail" — offline is normal — but "would the picker be empty". A failed
 * or stale endpoint whose provider ships a vendored catalog still has
 * models to show, and a provider with no listing route is static by
 * design: neither interrupts. Only an endpoint that failed *and* has
 * nothing behind it (no live models, no vendored catalog) earns a notice.
 */
export function reportNeedsNotice(report: LiveCatalogReport): boolean {
  return Object.values(report).some(({ models, status, type }) =>
    (status.kind === "failed" || status.kind === "stale") &&
    models.length === 0 &&
    !hasVendoredCatalog(type),
  );
}

/**
 * The orchestrator the clients call at startup (fire-and-forget) and on
 * a forced picker refresh: for every configured endpoint, report what
 * happened to its listing (ADR-0045) alongside the live-only models. An
 * endpoint with a vendored catalog AND a verified live contract is served
 * from a fresh cache or fetched live; a failed refresh falls back to the
 * stale cached list when one exists (offline with an expired cache still
 * shows the last known live models); a kind with no verified contract
 * (baseten) reports `unsupported`. Honors the `liveModels.enabled` config
 * switch (default on) — disabled means no endpoint is reported at all.
 *
 * Never throws for a provider failure: the failure *is* the status.
 */
export async function fetchLiveCatalogs(
  endpoints: { name: string; type: string; baseUrl?: string; apiKey?: string }[],
  opts: FetchLiveCatalogsOptions = {},
): Promise<LiveCatalogReport> {
  const config = readLiveModelsConfig(opts.mohHome);
  if (config.enabled === false) return {};
  const cacheFile = opts.cacheFile ?? liveModelCacheFile(opts.mohHome);
  const now = opts.now ?? Date.now();
  const report: LiveCatalogReport = {};
  const targets: typeof endpoints = [];
  // Static by design: reported, never fetched, never a failure (ADR-0045).
  for (const e of endpoints) {
    if (!hasVendoredCatalog(e.type)) continue;
    if (CONTRACTS[e.type] === undefined) {
      report[e.name] = { models: [], status: { kind: "unsupported" }, type: e.type };
      continue;
    }
    targets.push(e);
  }
  if (targets.length === 0) return report;
  const cache = await loadLiveModelCache(cacheFile);
  const ttl = config.ttlHours ?? DEFAULT_TTL_HOURS;
  const fresh = freshCacheEntries(cache, ttl, now);
  const toFetch: typeof targets = [];
  for (const e of targets) {
    const cached = fresh[e.name];
    if (cached && !opts.force) {
      const entry = cache[e.name];
      report[e.name] = { models: cached, status: { kind: "cached", ageHours: hoursSince(entry?.fetchedAt ?? now, now) }, type: e.type };
    } else toFetch.push(e);
  }
  const results = await Promise.all(
    toFetch.map(async (e) => {
      try {
        const models = await listProviderModels(e.type, e.name, {
          baseUrl: e.baseUrl,
          apiKey: e.apiKey,
          configFile: opts.configFile,
          fetchImpl: opts.fetchImpl,
          clientVersion: opts.clientVersion,
        });
        return [e.name, { models, status: { kind: "fresh" } as LiveCatalogStatus, type: e.type, entry: { fetchedAt: now, models } }] as const;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Refresh failed (offline, auth, remote error): fall back to the
        // stale cache entry when one exists — better than nothing, and now
        // named as what it is rather than implied.
        const stale = cache[e.name];
        return stale
          ? ([e.name, { models: stale.models, status: { kind: "stale", ageHours: hoursSince(stale.fetchedAt, now) } as LiveCatalogStatus, type: e.type, entry: undefined }] as const)
          : ([e.name, { models: [] as LiveModelListing[], status: { kind: "failed", reason } as LiveCatalogStatus, type: e.type, entry: undefined }] as const);
      }
    }),
  );
  const succeeded: Record<string, LiveModelCacheEntry> = {};
  for (const r of results) {
    if (!r) continue;
    const [name, outcome] = r;
    report[name] = { models: outcome.models, status: outcome.status, type: outcome.type };
    if (outcome.entry) succeeded[name] = outcome.entry;
  }
  if (Object.keys(succeeded).length > 0) {
    try {
      await saveLiveModelCache(succeeded, cacheFile);
    } catch {
      // A cache write failure must never surface — the in-memory result stands.
    }
  }
  return report;
}
