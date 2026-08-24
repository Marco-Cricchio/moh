/**
 * Wire/API separation (ADR-0010, issue #159): a provider is auth +
 * backend + catalog; the *wire* is the message format a backend speaks.
 * Until now the AI SDK adapter dispatched on `Endpoint.kind`, which
 * worked while kind == wire (anthropic/openai/google). The four new
 * builtin OAuth providers break that: kimi-coding and github-copilot
 * speak `anthropic-messages` against non-Anthropic backends, and copilot
 * switches wire per model. Dispatch moves to this vocabulary.
 */

/** The message formats the AI SDK adapter can speak. */
export type WireApi = "anthropic-messages" | "openai-chat" | "openai-responses" | "google";

/** New builtin provider kinds (ADR-0010). */
export const OAUTH_BUILTIN_KINDS = ["github-copilot", "openrouter", "kimi-coding", "xai"] as const;
export type OAuthBuiltinKind = (typeof OAUTH_BUILTIN_KINDS)[number];

export function isOAuthBuiltinKind(kind: string): kind is OAuthBuiltinKind {
  return (OAUTH_BUILTIN_KINDS as readonly string[]).includes(kind);
}

/**
 * Default wire per builtin kind. github-copilot is per-model (catalog
 * decides: anthropic-messages for claude, openai-responses/completions
 * for gpt/grok — issue #160/#164); this map is the fallback when no
 * catalog entry exists.
 */
const WIRE_FOR_KIND: Record<string, WireApi> = {
  anthropic: "anthropic-messages",
  openai: "openai-chat",
  google: "google",
  "openai-compat": "openai-chat",
  "github-copilot": "openai-chat",
  openrouter: "openai-chat",
  "kimi-coding": "anthropic-messages",
  xai: "openai-chat",
};

/** Wire for a builtin kind. Unknown kinds throw — a typo must fail
 * loudly, not silently fall back to chat-completions (fail-fast). */
export function wireForKind(kind: string): WireApi {
  const wire = WIRE_FOR_KIND[kind];
  if (wire === undefined) {
    throw new Error(`provider kind "${kind}" has no wire mapping; it cannot use the default AI SDK factory`);
  }
  return wire;
}

/** Default backend base URL per new builtin kind (api-key posture uses
 * these when the profile has no explicit baseUrl). */
export const OAUTH_BUILTIN_BASE_URLS: Record<OAuthBuiltinKind, string> = {
  "github-copilot": "https://api.individual.githubcopilot.com",
  openrouter: "https://openrouter.ai/api/v1",
  "kimi-coding": "https://api.kimi.com/coding",
  xai: "https://api.x.ai/v1",
};
