/**
 * Live model-list adapters for catalog-backed providers (#551): one
 * verified contract per provider — no guessing. The vendored
 * subscription catalogs (#156/#164, regenerated from pi-ai) stay the
 * metadata source of truth; a live listing only *adds* models the
 * vendored file does not yet carry, so newly released models appear
 * without a moh release.
 *
 * Provider contracts (audited against official docs / upstream client
 * sources; see the per-adapter docblocks):
 *  - openai (ChatGPT/Codex backend): `models[].slug`, `originator` +
 *    `client_version`; only `visibility: "list"` + `supported_in_api`.
 *  - anthropic: `GET /v1/models`, paginated (`has_more`/`after_id`),
 *    `max_input_tokens`.
 *  - google: `GET /v1beta/models`, paginated (`nextPageToken`),
 *    `generateContent` filter.
 *  - openrouter: public `GET /api/v1/models`, complete list.
 *  - xai / github-copilot: OpenAI-like `data[].id` (copilot needs its
 *    full editor-header client profile).
 *  - kimi-coding, zai: NO verified listing contract — deliberately
 *    static (the regen-from-pi-ai path is their update story).
 *
 * Failures are silent degradation; fetched-only entries carry
 * conservative metadata (moh never invents capabilities).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";import type { CatalogModel } from "./model-catalog";
import { subscriptionModelCatalog } from "./model-catalog";
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

/** Providers with a verified live-listing contract, and their base URLs. */
const LISTING_URLS: Record<string, string | undefined> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: CHATGPT_CODEX_BASE_URL,
  google: "https://generativelanguage.googleapis.com/v1beta",
  "github-copilot": OAUTH_BUILTIN_BASE_URLS["github-copilot"],
  openrouter: OAUTH_BUILTIN_BASE_URLS.openrouter,
  xai: OAUTH_BUILTIN_BASE_URLS.xai,
  // No verified listing contract (kimi-coding: no public /models on the
  // coding backend; zai: Coding Plan documents inference endpoints only).
  "kimi-coding": undefined,
  zai: undefined,
};

/** True when the kind has a vendored catalog worth augmenting. */
export function hasVendoredCatalog(type: string): boolean {
  return subscriptionModelCatalog(type).length > 0;
}

// ── per-contract parsers ─────────────────────────────────────────────────

type Parser = (body: unknown) => LiveModelListing[] | undefined;

/** OpenAI-like `{ data: [{ id, … }] }` (xai, github-copilot). */
const parseOpenAiData: Parser = (body) => {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return undefined;
  const out: LiveModelListing[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || !id) continue;
    const name = (entry as Record<string, unknown>).display_name;
    const ctx = (entry as Record<string, unknown>).context_length;
    out.push({
      id,
      ...(typeof name === "string" && name ? { name } : {}),
      ...(typeof ctx === "number" ? { contextWindow: ctx } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
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
  return out.length > 0 ? out : undefined;
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
  return out.length > 0 ? out : undefined;
};

const PARSERS: Record<string, Parser> = {
  openai: parseCodexModels,
  anthropic: parseAnthropicModels,
  google: parseGoogleModels,
  openrouter: parseOpenAiData,
  xai: parseOpenAiData,
  "github-copilot": parseOpenAiData,
};

/** Legacy union parser kept for compatibility with the #555 tests:
 * tries Codex, then Google, then OpenAI-like. */
export function parseModelsResponse(body: unknown): LiveModelListing[] | undefined {
  return parseCodexModels(body) ?? parseGoogleModels(body) ?? parseOpenAiData(body);
}

// ── headers ──────────────────────────────────────────────────────────────

const ACCEPT = { Accept: "application/json" };

/** Request headers per kind: the credential goes where the provider
 * expects it. One auth mode per request — API-key headers and OAuth
 * bearer are never mixed. */
function listingHeaders(kind: string, credential: string | undefined): Record<string, string> {
  if (credential === undefined) return { ...ACCEPT };
  switch (kind) {
    case "anthropic":
      return { ...ACCEPT, "anthropic-version": "2023-06-01", "x-api-key": credential };
    case "google":
      return { ...ACCEPT, "x-goog-api-key": credential };
    case "github-copilot":
      // The Copilot client profile (same headers the vendored catalog
      // attaches per model).
      return {
        ...ACCEPT,
        Authorization: `Bearer ${credential}`,
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "vscode/1.95.0",
        "Editor-Plugin-Version": "copilot-chat/0.26.0",
        "User-Agent": "GitHubCopilotChat/0.26.0",
      };
    case "openai":
      // ChatGPT-backend contract: the Codex CLI originator identifies
      // the client (moh speaks the same backend via #151).
      return { ...ACCEPT, Authorization: `Bearer ${credential}`, originator: CHATGPT_CODEX_ORIGINATOR };
    default:
      return { ...ACCEPT, Authorization: `Bearer ${credential}` };
  }
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

/** Provider-specific listing URL builders (query strings included). */
function listingUrls(kind: string, base: string, clientVersion: string): string[] {
  switch (kind) {
    case "anthropic":
      return [`${base}/models?limit=1000`, `${base}/models?limit=1000&after_id={last}`];
    case "google":
      return [`${base}/models?pageSize=1000`, `${base}/models?pageSize=1000&pageToken={token}`];
    case "openai":
      return [`${base}/models?client_version=${encodeURIComponent(clientVersion)}`];
    default:
      return [`${base}/models`];
  }
}

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
  const base = opts.baseUrl ?? LISTING_URLS[kind];
  const parser = PARSERS[kind];
  if (!base || !parser) throw new Error(`no verified model listing contract for provider kind "${kind}"`);
  const clientVersion = opts.clientVersion ?? "0.0.0";
  const credential = listingCredential(kind, endpointName, opts.apiKey, opts.configFile ?? userConfigFile());
  const templates = listingUrls(kind, base, clientVersion);
  const doFetch = opts.fetchImpl ?? (async (u, headers) => {
    const res = await fetch(u, { headers, signal: opts.signal ?? AbortSignal.timeout(10_000) });
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
    const { status, json } = await doFetch(url, listingHeaders(kind, credential));
    if (status < 200 || status >= 300) throw new Error(`${url} → HTTP ${status}`);
    const parsed = parser(json);
    if (!parsed) {
      if (out.length === 0) throw new Error(`${url} → unrecognized model list shape`);
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
 * The orchestrator the clients call at startup (fire-and-forget) and on
 * a forced picker refresh: for every endpoint with a vendored catalog
 * AND a verified live contract, serve from a fresh cache or fetch live,
 * merge the results into the cache, and return the live listings per
 * endpoint name. A failed refresh falls back to the stale cached list
 * when one exists (offline with an expired cache still shows the last
 * known live models); endpoints with neither keep no entry. Honors the
 * `liveModels.enabled` config switch (default on). kimi-coding and zai
 * have no verified contract and are never fetched.
 */
export async function fetchLiveCatalogs(
  endpoints: { name: string; type: string; baseUrl?: string; apiKey?: string }[],
  opts: FetchLiveCatalogsOptions = {},
): Promise<Record<string, LiveModelListing[]>> {
  const config = readLiveModelsConfig(opts.mohHome);
  if (config.enabled === false) return {};
  const targets = endpoints.filter((e) => hasVendoredCatalog(e.type) && LISTING_URLS[e.type] !== undefined);
  if (targets.length === 0) return {};
  const cacheFile = opts.cacheFile ?? liveModelCacheFile(opts.mohHome);
  const now = opts.now ?? Date.now();
  const out: Record<string, LiveModelListing[]> = {};
  const toFetch: typeof targets = [];
  const cache = await loadLiveModelCache(cacheFile);
  const ttl = config.ttlHours ?? DEFAULT_TTL_HOURS;
  const fresh = freshCacheEntries(cache, ttl, now);
  for (const e of targets) {
    const cached = fresh[e.name];
    if (cached && !opts.force) out[e.name] = cached;
    else toFetch.push(e);
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
        return [e.name, { fetchedAt: now, models }] as const;
      } catch {
        // Refresh failed (offline, auth, remote error): fall back to the
        // stale cache entry when one exists — better than nothing, still
        // a silent degradation.
        const stale = cache[e.name];
        return stale ? ([e.name, { fetchedAt: stale.fetchedAt, models: stale.models }] as const) : undefined;
      }
    }),
  );
  const succeeded: Record<string, LiveModelCacheEntry> = {};
  for (const r of results) {
    if (!r) continue;
    succeeded[r[0]] = r[1];
    out[r[0]] = r[1].models;
  }
  if (Object.keys(succeeded).length > 0) {
    try {
      await saveLiveModelCache(succeeded, cacheFile);
    } catch {
      // A cache write failure must never surface — the in-memory result stands.
    }
  }
  return out;
}
