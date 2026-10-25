/**
 * Wire/API separation (ADR-0010, issue #159): a provider is auth +
 * backend + catalog; the *wire* is the message format a backend speaks.
 * Until now the AI SDK adapter dispatched on `Endpoint.kind`, which
 * worked while kind == wire (anthropic/openai/google). The four new
 * builtin OAuth providers break that: kimi-coding and github-copilot
 * speak `anthropic-messages` against non-Anthropic backends, and copilot
 * switches wire per model. Dispatch moves to this vocabulary.
 */

import { PROVIDER_KINDS } from "./provider-kinds";

/** The message formats the AI SDK adapter can speak. */
export type WireApi = "anthropic-messages" | "openai-chat" | "openai-responses" | "google";

/** The kinds of the OAuth rows of a provider-kind table, as a tuple in table order. */
type OAuthKindsOf<T extends readonly unknown[]> = T extends readonly [infer H, ...infer R]
  ? H extends { readonly kind: infer K; readonly oauth: true }
    ? readonly [K, ...OAuthKindsOf<R>]
    : OAuthKindsOf<R>
  : readonly [];

/** New builtin provider kinds (ADR-0010). */
export const OAUTH_BUILTIN_KINDS = PROVIDER_KINDS.filter((row) => row.oauth).map((row) => row.kind) as unknown as OAuthKindsOf<typeof PROVIDER_KINDS> satisfies readonly string[];
export type OAuthBuiltinKind = (typeof OAUTH_BUILTIN_KINDS)[number];

export function isOAuthBuiltinKind(kind: string): kind is OAuthBuiltinKind {
  return (OAUTH_BUILTIN_KINDS as readonly string[]).includes(kind);
}

/**
 * Default wire per builtin kind. github-copilot and opencode are
 * per-model where the catalog knows better (the catalog decides:
 * anthropic-messages for claude, openai-responses/completions for
 * gpt/grok — issue #160/#164/#794); this map is the fallback when no
 * catalog entry exists — a live-listing-only model, for instance.
 *
 * For opencode that fallback is verified, not assumed (#920): the
 * Zen/Go backend serves every one of its models over
 * `/chat/completions` (probed with a live-only id, `grok-4.7`, and with
 * a catalog entry whose per-model wire is anthropic-messages,
 * `minimax-m3` — both answer 200), so a model moh has no metadata for
 * is still routable on the OpenAI wire.
 */
const WIRE_FOR_KIND: Record<string, WireApi> = {
  ...Object.fromEntries(PROVIDER_KINDS.map((row) => [row.kind, row.wire])),
  "openai-compat": "openai-chat",
};

/** Wire for a builtin kind. Unknown kinds throw — a typo must fail
 * loudly, not silently fall back to chat-completions (fail-fast). */
export function wireForKind(kind: string): WireApi {
  // Own entries only: "toString"/"__proto__" must not resolve through Object.prototype (#1570).
  const wire = Object.hasOwn(WIRE_FOR_KIND, kind) ? WIRE_FOR_KIND[kind] : undefined;
  if (wire === undefined) {
    throw new Error(`provider kind "${kind}" has no wire mapping; it cannot use the default AI SDK factory`);
  }
  return wire;
}

/** Default backend base URL per new builtin kind (api-key posture uses
 * these when the profile has no explicit baseUrl). */
export const OAUTH_BUILTIN_BASE_URLS: Record<OAuthBuiltinKind, string> = Object.fromEntries(
  PROVIDER_KINDS.flatMap((row) => (row.oauth ? [[row.kind, row.defaultBaseUrl]] : [])),
) as Record<OAuthBuiltinKind, string>;
