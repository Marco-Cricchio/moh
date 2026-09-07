/**
 * Live model-list augmentation for catalog-backed providers (#551): the
 * vendored subscription catalogs (#156/#164) stay the metadata source of
 * truth, but the provider's own model listing is fetched in the
 * background (startup + picker open) so newly released models appear in
 * the picker without a moh release.
 *
 * This deliberately relaxes the *no-network-fetch* clause of the #156
 * decision — not the rest of it: the vendored data files still own every
 * id they contain (vendored wins on collision), and metadata for
 * fetched-only models follows the documented conservative semantics
 * (unknown context window, no thinking level map, no modality claims —
 * moh never invents capabilities).
 *
 * Failure is always silent degradation: a broken remote, a missing
 * credential or a partial listing leaves the static catalog intact.
 * OpenAI-compat endpoints are out of scope here — their listing is
 * already live (`listOpenAiCompatModels`).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CatalogModel } from "./model-catalog";
import { subscriptionModelCatalog } from "./model-catalog";
import { OAUTH_BUILTIN_BASE_URLS, type OAuthBuiltinKind } from "./wire";
import { CHATGPT_CODEX_BASE_URL } from "./auth/openai";
import { readAuthSection, getStoredApiKey } from "./auth/store";
import { readUserConfigFile, userConfigFile } from "./user-config";

/** One model as the provider's listing exposes it. */
export interface LiveModelListing {
  id: string;
  name?: string;
  contextWindow?: number;
}

/** Injectable fetch seam (tests). */
export type ListingFetch = (url: string, headers: Record<string, string>) => Promise<{ status: number; json: unknown }>;

/** Listing endpoints per provider kind. Undefined = no known listing
 * (kimi-coding) — the fetcher skips it and the picker stays static. */
const LISTING_URLS: Record<string, string | undefined> = {
  anthropic: "https://api.anthropic.com/v1/models",
  openai: `${CHATGPT_CODEX_BASE_URL}/models`,
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  "github-copilot": `${OAUTH_BUILTIN_BASE_URLS["github-copilot"]}/models`,
  openrouter: `${OAUTH_BUILTIN_BASE_URLS.openrouter}/models`,
  xai: `${OAUTH_BUILTIN_BASE_URLS.xai}/models`,
  zai: "https://api.z.ai/api/paas/v4/models",
  "kimi-coding": undefined,
};

/** True when the kind has a vendored catalog worth augmenting. */
export function hasVendoredCatalog(type: string): boolean {
  return subscriptionModelCatalog(type).length > 0;
}

/** Union parser for the two listing shapes providers speak: the
 * OpenAI-ish `{ data: [{ id, ... }] }` and Google's
 * `{ models: [{ name: "models/x", ... }] }`. Returns undefined when
 * neither shape matches — the caller degrades to the static catalog. */
export function parseModelsResponse(body: unknown): LiveModelListing[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.data)) {
    const out: LiveModelListing[] = [];
    for (const entry of record.data) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || !e.id) continue;
      const listing: LiveModelListing = { id: e.id };
      if (typeof e.display_name === "string" && e.display_name) listing.name = e.display_name;
      if (typeof e.context_length === "number") listing.contextWindow = e.context_length;
      out.push(listing);
    }
    return out.length > 0 ? out : undefined;
  }
  if (Array.isArray(record.models)) {
    const out: LiveModelListing[] = [];
    for (const entry of record.models) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== "string" || !e.name) continue;
      const methods = Array.isArray(e.supportedGenerationMethods) ? e.supportedGenerationMethods : undefined;
      if (methods && !methods.includes("generateContent")) continue;
      const id = e.name.startsWith("models/") ? e.name.slice("models/".length) : e.name;
      if (!id) continue;
      const listing: LiveModelListing = { id };
      if (typeof e.displayName === "string" && e.displayName) listing.name = e.displayName;
      if (typeof e.inputTokenLimit === "number") listing.contextWindow = e.inputTokenLimit;
      out.push(listing);
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/** Request headers per kind: the credential goes where the provider
 * expects it; OpenAI-subscription-style Bearer is the fallback shape. */
function listingHeaders(kind: string, credential: string | undefined): Record<string, string> {
  if (credential === undefined) return { Accept: "application/json" };
  switch (kind) {
    case "anthropic":
      // OAuth grants ride Bearer; api keys ride x-api-key. Sending both
      // is accepted and keeps one code path.
      return { Accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": credential, Authorization: `Bearer ${credential}` };
    case "google":
      return { Accept: "application/json", "x-goog-api-key": credential };
    case "github-copilot":
      return { Accept: "application/json", Authorization: `Bearer ${credential}`, "Copilot-Integration-Id": "vscode-chat" };
    case "openrouter":
      return { Accept: "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) };
    default:
      return { Accept: "application/json", Authorization: `Bearer ${credential}` };
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

/**
 * Fetches one provider's live model list. Throws on any failure (HTTP
 * non-OK, unknown shape, network error, no known listing URL) — the
 * orchestrator degrades; direct callers should too.
 */
export async function listProviderModels(
  kind: string,
  endpointName: string,
  opts: { baseUrl?: string; apiKey?: string; configFile?: string; fetchImpl?: ListingFetch; signal?: AbortSignal } = {},
): Promise<LiveModelListing[]> {
  const base = opts.baseUrl ?? LISTING_URLS[kind];
  if (!base) throw new Error(`no model listing endpoint for provider kind "${kind}"`);
  const url = `${base.replace(/\/+$/, "")}/models`;
  const credential = listingCredential(kind, endpointName, opts.apiKey, opts.configFile ?? userConfigFile());
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
  const { status, json } = await doFetch(url, listingHeaders(kind, credential));
  if (status < 200 || status >= 300) throw new Error(`${url} → HTTP ${status}`);
  const parsed = parseModelsResponse(json);
  if (!parsed) throw new Error(`${url} → unrecognized model list shape`);
  return parsed;
}

/** Vendored entries win on id collision; fetched-only entries become
 * conservative picker rows, enriched where the listing offered data. */
export function mergeLiveCatalog(vendored: CatalogModel[], live: LiveModelListing[]): CatalogModel[] {
  const extra = live.filter((m) => !vendored.some((v) => v.id === m.id));
  const augmented: CatalogModel[] = extra.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? 0,
    reasoning: false,
  }));
  return [...vendored, ...augmented];
}

// --- user config (`~/.moh/config`, `liveModels` section) ---

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

// --- disk cache (`~/.moh/live-models.json`) ---

export interface LiveModelCacheEntry {
  fetchedAt: number;
  models: LiveModelListing[];
}

export function liveModelCacheFile(home?: string): string {
  return join(home ?? homedir(), ".moh", "live-models.json");
}

export function readLiveModelCache(file: string = liveModelCacheFile()): Record<string, LiveModelCacheEntry> {
  return {};
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

/** Entries whose cache age is within the TTL (or that were never
 * fetched — those need no TTL gate; an empty list means no cache). */
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
}

/**
 * The orchestrator the clients call at startup (fire-and-forget) and on
 * a forced picker refresh: for every endpoint with a vendored catalog,
 * serve from a fresh cache or fetch live, merge the results into the
 * cache, and return the live listings per endpoint name. Endpoints that
 * fail keep no entry — the caller's merge simply adds nothing. Honors
 * the `liveModels.enabled` config switch (default on).
 */
export async function fetchLiveCatalogs(
  endpoints: { name: string; type: string; baseUrl?: string; apiKey?: string }[],
  opts: FetchLiveCatalogsOptions = {},
): Promise<Record<string, LiveModelListing[]>> {
  const config = readLiveModelsConfig(opts.mohHome);
  if (config.enabled === false) return {};
  const targets = endpoints.filter((e) => hasVendoredCatalog(e.type));
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
        });
        return [e.name, { fetchedAt: now, models }] as const;
      } catch {
        return undefined;
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
