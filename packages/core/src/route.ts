import type { Message, Provider, StreamEvent, StreamOptions, ToolSpec } from "./types";
import type { AuthMethodKind } from "./auth/types";
import type { EndpointAuthContext } from "./auth/resolve";
import { normalizeProviderError, isFallbackWorthy, isRetryable } from "./provider-errors";
import { aiSdkStreamFor, type AiSdkTransport } from "./providers/ai-sdk";
import { resolveEndpointCredential } from "./auth/resolve";
import type { EndpointCapabilities, ThinkingFormat } from "./types";
import type { WireApi } from "./wire";

/** What a provider implementation an Endpoint instantiates. */
export type ProviderKind =
  | "anthropic"
  | "openai"
  | "google"
  | "github-copilot"
  | "openrouter"
  | "kimi-coding"
  | "xai"
  | "mock"
  | "custom";

export interface EndpointConfig {
  /** Endpoint name, e.g. "anthropic-work". Drives MOH_ENDPOINT_<NAME>_API_KEY. */
  name: string;
  kind: ProviderKind;
  /** Inline credential (moh.json keys). Falls back to the env var. */
  apiKey?: string;
  /** Override base URL (openai-compat style endpoints). */
  baseUrl?: string;
  /** Auth kind of the endpoint (absent = api-key, backward compatible). */
  auth?: { kind: AuthMethodKind };
  capabilities?: Partial<EndpointCapabilities>;
}

/**
 * A configured Provider instance with its own credentials. Two Anthropic
 * accounts are two Endpoints of the same kind.
 */
export class Endpoint {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly #apiKey: string | undefined;
  readonly baseUrl: string | undefined;
  readonly authKind: AuthMethodKind;
  readonly capabilities: EndpointCapabilities;

  constructor(config: EndpointConfig) {
    this.name = config.name;
    this.kind = config.kind;
    this.baseUrl = config.baseUrl;
    this.authKind = config.auth?.kind ?? "api-key";
    this.capabilities = {
      caching: config.capabilities?.caching ?? false,
      parallelToolCalls: config.capabilities?.parallelToolCalls ?? true,
      multimodal: config.capabilities?.multimodal ?? true,
    };
    this.#apiKey = config.apiKey ?? envApiKey(config.name);
  }

  get apiKey(): string | undefined {
    return this.#apiKey;
  }
}

/** MOH_ENDPOINT_<NAME>_API_KEY, name uppercased with non-alphanumerics as `_`. */
export function endpointEnvVarName(endpointName: string): string {
  return `MOH_ENDPOINT_${endpointName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

export function envApiKey(endpointName: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return env[endpointEnvVarName(endpointName)];
}

/** One stop of a fallback chain: endpoint + model id. */
export interface RouteTarget {
  endpoint: Endpoint;
  /** Model id as the provider knows it, e.g. "claude-sonnet-4-5". */
  modelId: string;
  /** Wire override (ADR-0010): per-model wire for github-copilot and
   * future multi-wire providers; absent = wireForKind(endpoint.kind). */
  wire?: WireApi;
  /** Per-model headers (copilot editor headers, #160/#164). Sent in
   * addition to any auth-context headers. */
  headers?: Record<string, string>;
  /** Provider compat flags (#251): catalog `compat` metadata the wire
   * layer applies per model (e.g. openrouter `thinkingFormat`). */
  compat?: Record<string, unknown>;
  /** #256: a config-declared thinking format for this target (per-model
   * > endpoint-level declaration). The wire layer maps the canonical
   * level through this format when present, instead of the wire. */
  thinkingFormat?: ThinkingFormat;
}

export interface RouteConfig {
  /** Primary target: `endpoint/model-id`. */
  target: RouteTarget;
  /** Declared fallback chain, tried in order. No model equivalence assumed. */
  fallbacks?: RouteTarget[];
  /** Same-endpoint retries on rate_limited/network/overloaded before falling back. Default 1. */
  retries?: number;
  /** Backoff between retries, ms. Default 100. Tests use 0. */
  retryBackoffMs?: number;
  /** #243: endpoint-scoped thinking preference resolved independently for
   * every fallback target. When absent, the caller's neutral options pass
   * through unchanged (explicit session options/custom providers). */
  thinkingForTarget?: (target: RouteTarget) => StreamOptions["thinking"] | undefined;
  /**
   * Per-target stream factory override. Return a stream for targets you
   * handle; return undefined to use the default AI SDK factory. Tests
   * inject mocks for specific endpoints while keeping real ones live.
   * Receives the target's resolved credential (subscription access token
   * or api key) as its second argument, and — for OpenAI native grants
   * (#151) — the ChatGPT-backend transport context as its third.
   */
  createStream?: (target: RouteTarget, credential?: string, authContext?: EndpointAuthContext) => StreamFn | undefined;
  /**
   * Credential resolution override (#137): returns the credential a
   * target's stream call uses — a plain string, or (OpenAI native
   * grants, #151) an auth context with ChatGPT-backend transport hints
   * (baseUrl + headers). Default resolves subscription endpoints from
   * the auth store with proactive refresh (refresh-before-stream);
   * api-key endpoints short-circuit to their inline/env key.
   */
  credentialResolver?: (target: RouteTarget) => Promise<string | EndpointAuthContext | undefined>;
  /** Clock seam for deterministic session-health cooldown tests. */
  now?: () => number;
}

export interface Route extends Provider {
  /** User-selected target. It stays stable while a fallback serves calls. */
  readonly selected: string;
  /** Latest successful target, used directly on later model calls. */
  readonly serving: string;
  readonly ref: string;
  readonly capabilities: EndpointCapabilities;
  readonly chain: string[];
  /** Starts a user turn: allows one expired-selected recovery probe. */
  beginTurn(): void;
}

/**
 * `endpoint/model-id` with a declared fallback chain. Single-shot per
 * provider call; fallback triggers on quota_exhausted immediately and on
 * rate-limit/network/overload after retries. Mid-stream failures restart
 * the single-shot request on the next target (events already emitted to
 * the session log stay there).
 */
export function createRoute(config: RouteConfig): Route {
  const chain = [config.target, ...(config.fallbacks ?? [])];
  const retries = config.retries ?? 1;
  const backoff = config.retryBackoffMs ?? 100;
  const streamFactory = config.createStream ?? (() => undefined);
  const resolveCredential = config.credentialResolver ?? resolveEndpointCredential;
  const defaultFactory = defaultStreamFactory();
  const refFor = (target: RouteTarget) => `${target.endpoint.name}/${target.modelId}`;
  const now = config.now ?? Date.now;
  const selected = refFor(config.target);
  let servingIndex = 0;
  let selectedRecoveryDue = false;
  const failures = new Map<number, { kind: "quota_exhausted" | "rate_limited" | "overloaded" | "network"; count: number; until: number }>();
  const cooldownMs = (kind: "quota_exhausted" | "rate_limited" | "overloaded" | "network", count: number) => {
    if (kind === "quota_exhausted") return 15 * 60_000;
    const initial = kind === "rate_limited" ? 60_000 : kind === "overloaded" ? 30_000 : 15_000;
    const cap = kind === "rate_limited" ? 15 * 60_000 : kind === "overloaded" ? 5 * 60_000 : 2 * 60_000;
    return Math.min(initial * 2 ** (count - 1), cap);
  };
  const recordFailure = (index: number, kind: "quota_exhausted" | "rate_limited" | "overloaded" | "network") => {
    const prior = failures.get(index);
    const count = prior?.kind === kind ? prior.count + 1 : 1;
    failures.set(index, { kind, count, until: now() + cooldownMs(kind, count) });
  };
  const provider: Route = {
    get selected() { return selected; },
    get serving() { return refFor(chain[servingIndex]!); },
    ref: selected,
    name: selected,
    capabilities: config.target.endpoint.capabilities,
    chain: chain.map(refFor),
    beginTurn() {
      selectedRecoveryDue = servingIndex !== 0 && (failures.get(0)?.until ?? Infinity) <= now();
    },
    async *stream(messages: Message[], signal: AbortSignal, tools?: readonly ToolSpec[], options?: StreamOptions): AsyncIterable<StreamEvent> {
      const recoveryProbe = selectedRecoveryDue;
      selectedRecoveryDue = false;
      // Recovery probes go selected → existing serving target directly;
      // ordinary calls start from serving and then try viable alternatives.
      const order = recoveryProbe
        ? [0, servingIndex, ...chain.map((_target, index) => index).filter((index) => index !== 0 && index !== servingIndex)]
        : chain.map((_target, offset) => (servingIndex + offset) % chain.length);
      for (const i of order) {
        if (i !== order[0] && (failures.get(i)?.until ?? 0) > now()) continue;
        const target = chain[i]!;
        const targetThinking = config.thinkingForTarget?.(target);
        const targetOptions = config.thinkingForTarget
          ? (targetThinking ? { thinking: targetThinking } : undefined)
          : options;
        // #137: subscription credentials resolve (with proactive refresh)
        // once per target — before any stream call, never mid-stream, and
        // not re-resolved on retry (decision 6: no refresh retry loops).
        // Api-key targets keep the pre-#137 path untouched.
        const resolved = target.endpoint.authKind === "subscription"
          ? await resolveCredential(target)
          : target.endpoint.apiKey;
        // #151: OpenAI native grants resolve to an auth context carrying
        // the ChatGPT backend transport; plain strings (and api-key
        // targets) keep the endpoint's own baseUrl.
        const isContext = typeof resolved === "object" && resolved !== null;
        const credential = isContext ? resolved.credential : resolved;
        const authContext = isContext ? resolved : undefined;
        let attempt = 0;
        while (true) {
          try {
            const stream = streamFactory(target, credential, authContext) ?? defaultFactory(target, credential, authContext);
            for await (const event of stream(messages, signal, tools, targetOptions)) {
              yield event;
            }
            const previous = servingIndex;
            servingIndex = i;
            failures.delete(i);
            if (previous !== i) {
              yield { type: "route_serving", selected, serving: refFor(target), previous: refFor(chain[previous]!) };
            }
            return;
          } catch (err) {
            if (signal.aborted) return;
            const normalized = normalizeProviderError(err);
            if (isRetryable(normalized) && attempt < retries) {
              attempt += 1;
              if (backoff > 0) await Bun.sleep(backoff);
              continue;
            }
            if (isFallbackWorthy(normalized)) {
              recordFailure(i, normalized.kind as "quota_exhausted" | "rate_limited" | "overloaded" | "network");
              // A selected-route recovery is one probe only: after it
              // fails, resume the already-serving target directly rather
              // than walking other cooled-down fallback stops.
              const position = order.indexOf(i);
              const next = order.slice(position + 1).find((index) =>
                (failures.get(index)?.until ?? 0) <= now(),
              );
              if (next !== undefined) {
                // The detailed record stays in the log; the route_serving
                // event after success is the only user-visible transition.
                yield { type: "fallback", from: refFor(target), to: refFor(chain[next]!), reason: normalized.kind };
                break;
              }
            }
            throw normalized;
          }
        }
      }
    },
  };
  return provider;
}

type StreamFn = (messages: Message[], signal: AbortSignal, tools?: readonly ToolSpec[], options?: StreamOptions) => AsyncIterable<StreamEvent>;

function defaultStreamFactory(): (
  target: RouteTarget,
  credential: string | undefined,
  authContext: EndpointAuthContext | undefined,
) => StreamFn {
  // #159: the target itself can carry wire/headers (per-model catalog
  // metadata); they ride along even without an auth context.
  const toTransport = (
    target: RouteTarget,
    ctx: EndpointAuthContext | undefined,
  ): AiSdkTransport | undefined => {
    if (!ctx && target.wire === undefined && target.headers === undefined && !target.endpoint.baseUrl) return undefined;
    return {
      baseUrl: ctx?.baseUrl ?? target.endpoint.baseUrl,
      // Auth-context headers win on collision with catalog headers — the
      // credential's own transport (e.g. a copilot token's backend) is the
      // freshest source.
      headers: { ...(target.headers ?? {}), ...(ctx?.headers ?? {}) },
      wire: target.wire ?? ctx?.wire,
    };
  };
  return (target, credential, authContext) => aiSdkStreamFor(target, credential, toTransport(target, authContext));
}
