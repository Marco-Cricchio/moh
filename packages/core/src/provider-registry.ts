/**
 * The provider registry: built-in ids plus custom providers registered
 * programmatically via registerProvider. A session freezes the registry
 * at creation, so later registrations never affect running sessions
 * (issue #29).
 */
import { MockProvider } from "./mock-provider";
import { EchoProvider } from "./echo-provider";
import { Endpoint, createRoute, envApiKey, type ProviderKind, type RouteTarget } from "./route";
import type { EndpointProfile, MohConfig } from "./config";
import type { Provider, StreamOptions } from "./types";
import { OAUTH_BUILTIN_BASE_URLS, isOAuthBuiltinKind, type OAuthBuiltinKind } from "./wire";
import { catalogEntryFor } from "./model-catalog";

/** Options a custom provider factory receives from an endpoint profile. */
export interface ProviderFactoryOptions {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
}

/** A custom provider implementation: returns a single-shot Provider. */
export type ProviderFactory = (options: ProviderFactoryOptions) => Provider;

/**
 * Immutable snapshot of a registry. What AgentSession holds: taken at
 * creation, never observes later registrations.
 */
export class FrozenProviderRegistry {
  readonly #factories: ReadonlyMap<string, ProviderFactory>;

  constructor(factories: ReadonlyMap<string, ProviderFactory>) {
    this.#factories = factories;
  }

  has(id: string): boolean {
    return this.#factories.has(id);
  }

  get(id: string): ProviderFactory | undefined {
    return this.#factories.get(id);
  }

  get ids(): string[] {
    return [...this.#factories.keys()];
  }
}

/** Mutable registry; the entry point is registerProvider. */
export class ProviderRegistry {
  readonly #factories = new Map<string, ProviderFactory>();

  /** Registers a custom provider implementation under `id`. Duplicate ids throw. */
  registerProvider(id: string, factory: ProviderFactory): this {
    if (!id || id.includes("/")) {
      throw new Error(`provider id must be a non-empty string without "/" (got ${JSON.stringify(id)})`);
    }
    if (typeof factory !== "function") {
      throw new Error(`provider "${id}": factory must be a function`);
    }
    if (this.#factories.has(id)) {
      throw new Error(`provider "${id}" is already registered`);
    }
    this.#factories.set(id, factory);
    return this;
  }

  has(id: string): boolean {
    return this.#factories.has(id);
  }

  get(id: string): ProviderFactory | undefined {
    return this.#factories.get(id);
  }

  /** Freezes the current registrations into an immutable snapshot. */
  freeze(): FrozenProviderRegistry {
    return new FrozenProviderRegistry(new Map(this.#factories));
  }
}

/**
 * The default registry. "mock" is always available: zero credentials,
 * for demos and first run.
 */
export const defaultRegistry = new ProviderRegistry()
  .registerProvider("mock", () => MockProvider.demo())
  .registerProvider("echo", () => new EchoProvider());

/** Splits "endpoint/model-id" on the first "/". Model part may be empty. */
function splitRef(ref: string): { name: string; modelId: string | undefined } {
  const slash = ref.indexOf("/");
  if (slash === -1) return { name: ref, modelId: undefined };
  const modelId = ref.slice(slash + 1);
  return { name: ref.slice(0, slash), modelId: modelId === "" ? undefined : modelId };
}

const BUILTIN_KINDS = new Set([
  "anthropic",
  "openai",
  "google",
  // ADR-0010 (#159): the four new OAuth providers are builtin kinds.
  "github-copilot",
  "openrouter",
  "kimi-coding",
  "xai",
]);

function resolveProfile(
  profile: EndpointProfile,
  modelId: string,
  registry: FrozenProviderRegistry,
  fallbacks: RouteTarget[],
  thinkingForTarget?: (target: RouteTarget) => StreamOptions["thinking"] | undefined,
): Provider {
  const apiKey = profile.apiKey ?? envApiKey(profile.name);
  const route = (target: RouteTarget): Provider =>
    createRoute({ target, ...(fallbacks.length ? { fallbacks } : {}), ...(thinkingForTarget ? { thinkingForTarget } : {}) });
  if (BUILTIN_KINDS.has(profile.type)) {
    return route(routeTargetFor(profile, modelId, apiKey));
  }
  if (profile.type === "openai-compat") {
    if (!profile.baseUrl) {
      throw new Error(`endpoint "${profile.name}": openai-compat requires baseUrl`);
    }
    // Local endpoints (Ollama, LM Studio, ...) ignore the key, but the
    // wire protocol wants one; a dummy default keeps zero-credential setups working.
    return route(routeTargetFor(profile, modelId, apiKey ?? "ollama"));
  }
  const factory = registry.get(profile.type);
  if (!factory) {
    throw new Error(
      `endpoint "${profile.name}": unknown provider type "${profile.type}" (not a built-in and not registered)`,
    );
  }
  return factory({ apiKey, baseUrl: profile.baseUrl, modelId });
}

/** #164: per-model catalog overrides for a route target — wire (copilot
 * claude vs gpt) and headers (copilot editor headers). Exported from the
 * defining module (ADR-0004) for direct testing. */
export function catalogTargetOverrides(kind: string, modelId: string): { wire?: RouteTarget["wire"]; headers?: Record<string, string>; compat?: Record<string, unknown> } {
  if (!isOAuthBuiltinKind(kind)) return {};
  const entry = catalogEntryFor(kind, modelId);
  return { ...(entry?.wire ? { wire: entry.wire } : {}), ...(entry?.headers ? { headers: entry.headers } : {}), ...(entry?.compat ? { compat: entry.compat } : {}) };
}

function routeTargetFor(profile: EndpointProfile, modelId: string, apiKey: string | undefined): RouteTarget {
  // openai-compat travels the OpenAI Chat Completions wire protocol as a
  // plain "openai" endpoint; every other builtin keeps its own kind —
  // the wire mapping lives in wire.ts (ADR-0010), not here.
  const kind = profile.type === "openai-compat" ? "openai" : profile.type;
  // New builtin kinds default their backend base URL when the profile
  // has none (subscription grants override it via the auth context).
  const baseUrl = profile.baseUrl ?? OAUTH_BUILTIN_BASE_URLS[kind as OAuthBuiltinKind];
  return {
    endpoint: new Endpoint({
      name: profile.name,
      kind: kind as ProviderKind,
      apiKey,
      baseUrl,
      auth: profile.auth,
      capabilities: profile.capabilities,
    }),
    modelId,
    ...catalogTargetOverrides(kind, modelId),
  };
}

/**
 * ADR-0012 (#234): estimates a provider's remaining health/quota on an
 * abstract 0–100 scale (higher = more remaining). `undefined` = unknown —
 * unknown providers sort after known ones in the automatic fallback
 * chain. No builtin estimator exists yet; callers (tests, future quota
 * retrieval) inject it via `RouteResolutionOptions.health`.
 */
export type ProviderHealthEstimator = (profile: EndpointProfile) => number | undefined;

export interface RouteResolutionOptions {
  health?: ProviderHealthEstimator;
  /** Endpoint preference seam resolved per target, including fallbacks. */
  thinkingForTarget?: (target: RouteTarget) => StreamOptions["thinking"] | undefined;
}

function isRouteCapable(profile: EndpointProfile): boolean {
  return BUILTIN_KINDS.has(profile.type) || profile.type === "openai-compat";
}

/**
 * ADR-0012 (#234): the automatic fallback stops for an active provider —
 * every other configured endpoint that is route-capable, fallback-eligible
 * (default) and has a defaultModel. Order: known health descending first
 * (fallbacks only — the active provider stays first regardless), unknown
 * health last, declaration order as tiebreaker. Custom (factory) types
 * cannot be route stops and are skipped.
 */
function fallbackStopsFor(
  active: EndpointProfile,
  endpoints: EndpointProfile[],
  health: ProviderHealthEstimator | undefined,
): RouteTarget[] {
  const candidates = endpoints.filter(
    (e) =>
      e.name !== active.name &&
      e.fallbackEligible !== false &&
      e.defaultModel !== undefined &&
      isRouteCapable(e),
  );
  const ranked = candidates
    .map((e, index) => ({ e, index, h: health?.(e) }))
    .sort((a, b) => {
      if (a.h !== undefined && b.h !== undefined && a.h !== b.h) return b.h - a.h;
      if (a.h !== undefined && b.h === undefined) return -1;
      if (a.h === undefined && b.h !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ e }) => routeTargetFor(e, e.defaultModel!, e.apiKey ?? envApiKey(e.name)));
  return ranked;
}

/**
 * Resolves a provider reference against a frozen registry and the
 * configured endpoint profiles.
 *
 * Accepted forms:
 * - "mock" (or any registered custom id) — the factory result
 * - "endpoint/model-id" — a route over the named profile
 * - "endpoint" — the profile's defaultModel
 *
 * Route-capable providers get the ADR-0012 automatic fallback chain:
 * the other configured endpoints, health-ordered (unknown last).
 */
export function resolveProviderRef(
  ref: string,
  registry: FrozenProviderRegistry,
  endpoints: EndpointProfile[],
  options: RouteResolutionOptions = {},
): Provider {
  if (!ref) throw new Error("empty provider reference");
  const factory = registry.get(ref);
  if (factory) return factory({});
  const { name, modelId } = splitRef(ref);
  const profile = endpoints.find((e) => e.name === name);
  if (!profile) {
    throw new Error(
      `unknown provider "${ref}": not a registered provider id and no endpoint "${name}" in moh.json`,
    );
  }
  const resolvedModel = modelId ?? profile.defaultModel;
  if (!resolvedModel) {
    throw new Error(`provider "${ref}": endpoint "${name}" has no defaultModel; use "${name}/<model-id>"`);
  }
  return resolveProfile(
    profile,
    resolvedModel,
    registry,
    // Custom-factory providers cannot be route stops: skip the (discarded)
    // chain construction for them.
    isRouteCapable(profile) ? fallbackStopsFor(profile, endpoints, options.health) : [],
    options.thinkingForTarget,
  );
}

/**
 * Builds the default Provider for a moh.json config. Defaults to the
 * zero-credential mock provider when nothing is configured.
 */
export function resolveProvider(
  config: MohConfig,
  registry: ProviderRegistry = defaultRegistry,
  options: RouteResolutionOptions = {},
): Provider {
  return resolveProviderRef(config.provider ?? "mock", registry.freeze(), config.endpoints ?? [], options);
}
