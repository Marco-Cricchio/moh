import type { Message, Provider, StreamEvent, ToolSpec } from "./types";
import type { AuthMethodKind } from "./auth/types";
import type { EndpointAuthContext } from "./auth/resolve";
import { normalizeProviderError, isFallbackWorthy, isRetryable } from "./provider-errors";
import { aiSdkStreamFor, type AiSdkTransport } from "./providers/ai-sdk";
import { resolveEndpointCredential } from "./auth/resolve";
import type { EndpointCapabilities } from "./types";
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
}

export interface Route extends Provider {
  readonly ref: string;
  readonly capabilities: EndpointCapabilities;
  readonly chain: string[];
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
  const provider: Route = {
    ref: `${config.target.endpoint.name}/${config.target.modelId}`,
    name: `${config.target.endpoint.name}/${config.target.modelId}`,
    capabilities: config.target.endpoint.capabilities,
    chain: chain.map((t) => `${t.endpoint.name}/${t.modelId}`),
    async *stream(messages: Message[], signal: AbortSignal, tools?: readonly ToolSpec[]): AsyncIterable<StreamEvent> {
      for (let i = 0; i < chain.length; i++) {
        const target = chain[i]!;
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
            for await (const event of stream(messages, signal, tools)) {
              yield event;
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
            if (isFallbackWorthy(normalized) && i < chain.length - 1) break; // next target
            throw normalized;
          }
        }
      }
    },
  };
  return provider;
}

type StreamFn = (messages: Message[], signal: AbortSignal, tools?: readonly ToolSpec[]) => AsyncIterable<StreamEvent>;

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
