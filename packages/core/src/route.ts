import type { Message, Provider, ProviderErrorKind, StreamEvent, StreamOptions, ToolSpec } from "./types";
import type { AuthMethodKind } from "./auth/types";
import type { EndpointAuthContext } from "./auth/resolve";
import { normalizeProviderError, isFallbackWorthy, isRetryable } from "./provider-errors";
import { ProviderError } from "./types";
import { aiSdkStreamFor, type AiSdkTransport } from "./providers/ai-sdk";
import { resolveEndpointCredential } from "./auth/resolve";
import type { EndpointCapabilities, ThinkingFormat } from "./types";
import type { WireApi } from "./wire";
import { providerProfile } from "./provider-profiles";

/** What a provider implementation an Endpoint instantiates. */
export type ProviderKind =
  | "anthropic"
  | "openai"
  | "google"
  | "github-copilot"
  | "openrouter"
  | "kimi-coding"
  | "xai"
  | "deepseek" | "groq" | "cerebras" | "nvidia-nim" | "together" | "fireworks" | "huggingface" | "mistral"
  | "moonshot" | "minimax" | "zai" | "qwen" | "xiaomi-mimo" | "vercel-ai-gateway" | "cloudflare-ai-gateway" | "baseten"
  | "opencode"
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
    this.#apiKey = config.apiKey ?? envApiKey(config.name) ?? providerApiKey(config.kind);
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

/** Documented provider credential fallback. Endpoint-specific MOH_ENDPOINT_* wins. */
export function providerApiKey(kind: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (kind === "opencode") return env.OPENCODE_API_KEY;
  const key = providerProfile(kind)?.apiKeyEnv;
  return key ? env[key] : undefined;
}

export function resolveApiKey(endpointName: string, kind: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return envApiKey(endpointName, env) ?? providerApiKey(kind, env);
}

/** The provider-error kinds a stop's cooldown is recorded for (ADR-0012:
 * the fallback-worthy ones plus the deterministic request rejections). */
type RouteFailureKind = "quota_exhausted" | "rate_limited" | "overloaded" | "network" | "invalid_request" | "empty_completion";

const FAILURE_KINDS: readonly RouteFailureKind[] = [
  "quota_exhausted",
  "rate_limited",
  "overloaded",
  "network",
  "invalid_request",
  "empty_completion",
];

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
  /**
   * ADR-0050 (§4, §5): the state a **child** route is born in, handed down
   * by the parent session that spawns it. Facts travel, state does not: the
   * serving index starts where the parent is, the known cooldown deadlines
   * are seeded as given (an exhausted quota is a fact about the account,
   * not about one session), and the failure counters, the recovery probes
   * and every later transition are the child's own. Absent for a route a
   * session builds for itself: it starts on its selected reference.
   */
  inherited?: {
    /** The stop serving from birth — one of the chain's refs. An unknown
     * ref (the owner's config changed) is ignored: the route starts on its
     * selection rather than inventing a stop. */
    serving: string;
    /** Known cooldown deadlines per stop ref. Only deadlines: a seeded
     * entry carries no failure count, so the child's first real failure on
     * that stop computes its own cooldown. */
    cooldowns?: ReadonlyArray<{ ref: string; kind: string; until: number }>;
  };
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
  /**
   * #852: endpoint health at decision time — for each chain stop, whether
   * it is in a failure cooldown (the kind that put it there). The routing
   * layer reads this before it names a switch target: a model the session
   * already knows cannot serve it is never chosen.
   */
  health(): ReadonlyArray<{ ref: string; kind: string; until: number }>;
  /**
   * ADR-0050 (§4, §5): an independent route over the same chain and the
   * same wiring (stream factory, credential resolver, retries, clock,
   * thinking seam), born where **this** route is now: the same selection,
   * the same serving stop, and the cooldown deadlines this route knows.
   * The subagent host builds one per spawn, so a child owns its serving
   * index, its counters and its transitions — nothing it does can move the
   * parent's model, and nothing the parent does afterwards moves the
   * child's.
   */
  childRoute(): Route;
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
  // #873 follow-up: transient upstream 5xx (classified `overloaded`,
  // e.g. opencode-go's "Upstream response was not valid JSON") are
  // frequent and usually clear within a second or two — one attempt is
  // not enough before falling back. Give `overloaded` a deeper
  // same-endpoint retry budget (still bounded by `retries` when the
  // user raises it explicitly).
  const maxAttempts = (kind: ProviderErrorKind): number => (kind === "overloaded" ? Math.max(retries, 3) : retries);
  const streamFactory = config.createStream ?? (() => undefined);
  const resolveCredential = config.credentialResolver ?? resolveEndpointCredential;
  const defaultFactory = defaultStreamFactory();
  const refFor = (target: RouteTarget) => `${target.endpoint.name}/${target.modelId}`;
  const now = config.now ?? Date.now;
  const selected = refFor(config.target);
  // ADR-0050: a child route is born where its parent is — same selection,
  // the parent's serving stop, the deadlines the parent already knows. A
  // `serving` ref that is not in this route's chain (the owner's config
  // changed between spawn and assembly) is ignored: the route starts on its
  // selection rather than inventing a stop.
  let servingIndex = Math.max(0, chain.findIndex((target) => refFor(target) === config.inherited?.serving));
  let selectedRecoveryDue = false;
  const failures = new Map<number, { kind: RouteFailureKind; count: number; until: number }>();
  const failureKind = (kind: string): RouteFailureKind | undefined =>
    (FAILURE_KINDS as readonly string[]).includes(kind) ? (kind as RouteFailureKind) : undefined;
  for (const inherited of config.inherited?.cooldowns ?? []) {
    const index = chain.findIndex((target) => refFor(target) === inherited.ref);
    const kind = failureKind(inherited.kind);
    // Count 0: the deadline is inherited, the counter is not — the child's
    // own first failure on this stop is its first (cooldownMs(count 1)).
    if (index !== -1 && kind !== undefined && inherited.until > now()) failures.set(index, { kind, count: 0, until: inherited.until });
  }
  const cooldownMs = (kind: RouteFailureKind, count: number) => {
    if (kind === "quota_exhausted") return 15 * 60_000;
    // #853: an endpoint that returned an empty completion is cooldown-worthy
    // like a quota failure — re-probing it next turn replays the same
    // silent failure; 15 minutes matches quota/invalid_request.
    if (kind === "empty_completion") return 15 * 60_000;
    // #506: a deterministic invalid_request rejection (e.g. a text-only
    // fallback target vs. multimodal history) is cooldown-worthy too:
    // re-probing it every turn replays the same failure with zero progress.
    if (kind === "invalid_request") return 15 * 60_000;
    const initial = kind === "rate_limited" ? 60_000 : kind === "overloaded" ? 30_000 : 15_000;
    const cap = kind === "rate_limited" ? 15 * 60_000 : kind === "overloaded" ? 5 * 60_000 : 2 * 60_000;
    return Math.min(initial * 2 ** (count - 1), cap);
  };
  const recordFailure = (index: number, kind: RouteFailureKind) => {
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
      // #363: a user turn is the boundary where returning to the selected
      // stop may be retried. A stop the session knows is still cooling down
      // is not re-probed (ADR-0050 §5: the knowledge is a fact, not a
      // per-session habit — a child born on an inherited cooldown must not
      // spend its first call on the stop its parent already found dead).
      // The probe arms the moment that deadline expires.
      const expired = (failures.get(0)?.until ?? Infinity) <= now();
      selectedRecoveryDue = servingIndex !== 0 && expired;
    },
    health() {
      const t = now();
      const out: { ref: string; kind: string; until: number }[] = [];
      for (const [index, failure] of failures) {
        if (failure.until > t) out.push({ ref: refFor(chain[index]!), kind: failure.kind, until: failure.until });
      }
      return out;
    },
    childRoute() {
      // ADR-0050: the child gets the facts (where we are, what we know is
      // dead and until when) and its own state from birth. The chain and
      // every wiring seam ride along unchanged — same config, minus the
      // state this closure owns.
      return createRoute({
        ...config,
        inherited: { serving: refFor(chain[servingIndex]!), cooldowns: provider.health() },
      });
    },
    async *stream(messages: Message[], signal: AbortSignal, tools?: readonly ToolSpec[], options?: StreamOptions): AsyncIterable<StreamEvent> {
      const recoveryProbe = selectedRecoveryDue;
      selectedRecoveryDue = false;
      // Recovery probes go selected → existing serving target directly;
      // ordinary calls start from serving and then try viable alternatives.
      const walkInOrder = recoveryProbe
        ? [0, servingIndex, ...chain.map((_target, index) => index).filter((index) => index !== 0 && index !== servingIndex)]
        : chain.map((_target, offset) => (servingIndex + offset) % chain.length);
      // ADR-0050 §5: a stop the session knows is cooling down is stepped
      // over wherever it appears in the walk. The cooldown is a *fact* (an
      // exhausted account, a deadline inherited from the session that found
      // it), not a habit of this one: a child born serving `b` must not
      // spend its first call re-probing the `a` its parent already found
      // dead, nor report a fallback it never watched happen. When the walk
      // is spendable nowhere (every stop cooled), it falls back to the
      // ordinary order, so the failure the user needs to see still surfaces
      // from the stop this session leads with — never a silent no-op.
      const spendable = (i: number) => (failures.get(i)?.until ?? 0) <= now();
      const viable = walkInOrder.filter(spendable);
      const walk = viable.length > 0 ? viable : walkInOrder;
      for (const i of walk) {
        if (i !== walk[0] && !spendable(i)) continue;
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
        // #853: an empty completion (finish, but no text, no tool calls,
        // no usage) is a failed call, not an answer — the provider could
        // not actually serve the request. Detected here, at the route
        // layer, so every provider kind gets the same classification and
        // the fallback chain fires. Reset per attempt: a retry gets its
        // own accounting.
        while (true) {
          let sawText = false;
          let sawToolCalls = false;
          let sawUsage = false;
          try {
            const stream = streamFactory(target, credential, authContext) ?? defaultFactory(target, credential, authContext);
            for await (const event of stream(messages, signal, tools, targetOptions)) {
              if (event.type === "text_delta") {
                if (event.text) sawText = true;
              } else if (event.type === "tool_calls") {
                if (event.calls.length > 0) sawToolCalls = true;
              } else if (event.type === "usage") {
                // Zero tokens is the shape of an empty completion (the
                // adapter defaults missing usage to 0), never evidence of
                // a real call.
                if (event.inputTokens > 0 || event.outputTokens > 0) sawUsage = true;
              }
              yield event;
            }
            if (!sawText && !sawToolCalls && !sawUsage) {
              throw new ProviderError(
                "empty_completion",
                `${refFor(target)} returned an empty completion (no content, no tool calls, no usage)`,
              );
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
            if (isRetryable(normalized) && attempt < maxAttempts(normalized.kind)) {
              attempt += 1;
              if (backoff > 0) await Bun.sleep(backoff);
              continue;
            }
            if (isFallbackWorthy(normalized)) {
              recordFailure(i, normalized.kind as RouteFailureKind);
              // A selected-route recovery is one probe only: after it
              // fails, resume the already-serving target directly rather
              // than walking other cooled-down fallback stops.
              const position = walk.indexOf(i);
              const next = walk.slice(position + 1).find((index) =>
                (failures.get(index)?.until ?? 0) <= now(),
              );
              if (next !== undefined) {
                // The detailed record stays in the log; the route_serving
                // event after success is the only user-visible transition.
                yield { type: "fallback", from: refFor(target), to: refFor(chain[next]!), reason: normalized.kind };
                break;
              }
            }
            // #506: a fallback stop that deterministically rejects the
            // request shape (invalid_request, e.g. text-only model vs.
            // multimodal history) is cooldown-worthy: record it so the
            // next turn does not re-probe it, and throw once with a
            // combined diagnostic that names the rejected target.
            if (normalized.kind === "invalid_request" && i !== 0) {
              recordFailure(i, "invalid_request");
              throw new ProviderError(
                "invalid_request",
                `${refFor(target)} rejected the request: ${normalized.message}`,
              );
            }
            throw normalized;
          }
        }
      }
    },
  };
  return provider;
}

/**
 * ADR-0050 (§4): the provider a subagent child runs on. A route hands down
 * its own instance (`Route.childRoute`) — the child owns its serving index,
 * its counters and its transitions from birth. Any other provider (a
 * pre-built instance, a bare registered id) is shared exactly as before:
 * it carries no route state to isolate.
 */
export function childRouteOf(provider: Provider): Provider {
  const route = provider as Partial<Route>;
  return typeof route.childRoute === "function" ? route.childRoute() : provider;
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
