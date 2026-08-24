/**
 * Credential resolution for streaming (issue #137, spec decision 6):
 * subscription endpoints resolve their access token from the auth store
 * with **proactive refresh** before the single `stream` call — never
 * mid-stream (principle 3 intact). Api-key endpoints are untouched: the
 * resolver returns the endpoint's inline/env key with no I/O.
 *
 * Refresh uses a Codex-style proactive window: a token expiring within
 * `REFRESH_WINDOW_MS` is refreshed (and re-persisted through the guardian)
 * before the credential is handed to the route's stream factory. Refresh
 * failure or a missing/expired login surfaces as `ProviderError` kind
 * `auth` with a `moh provider login <name>` hint; the route's fallback
 * chain then applies as usual.
 */
import type { RouteTarget } from "../route";
import { ProviderError } from "../types";
import { userConfigFile } from "../user-config";
import { readAuthSection, saveTokens } from "./store";
import type { AuthOverrides, AuthToken } from "./types";
import { refreshAnthropicToken, resolveAnthropicOAuthConfig } from "./anthropic";
import { refreshGoogleToken, resolveGoogleOAuthConfig } from "./google";
import { refreshOpenaiToken, resolveOpenAiOAuthConfig, CHATGPT_CODEX_BASE_URL, CHATGPT_CODEX_ORIGINATOR } from "./openai";
import type { WireApi } from "../wire";

/** Transport hints a resolver may return alongside the credential (#151):
 * OpenAI subscription grants that could not mint an API key stream via
 * the ChatGPT backend (Responses API wire + originator header) instead
 * of api.openai.com. */
export interface EndpointAuthContext {
  credential: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Wire protocol the baseUrl speaks (#151): the ChatGPT backend only
   * exposes the Responses API, unlike api.openai.com / compat endpoints. */
  wire?: WireApi;
}

/** ChatGPT-backend transport for a native (un-minted) OpenAI grant. */
export function openaiNativeAuthContext(token: AuthToken): EndpointAuthContext {
  return {
    credential: token.accessToken,
    baseUrl: CHATGPT_CODEX_BASE_URL,
    headers: { originator: CHATGPT_CODEX_ORIGINATOR },
    wire: "openai-responses",
  };
}

/** Refresh when the access token expires within this window (Codex-style). */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** HTTP seam shared by all three provider refresh grants (test seam). */
export type TokenFetch = (
  url: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

export interface CredentialResolveOptions {
  /** Auth store location. Default: `~/.moh/config` via the guardian. */
  configFile?: string;
  /** Clock, epoch ms. Default: `Date.now()`. */
  now?: number;
  /** Token-endpoint seam. Default: the providers' own `fetch`. */
  fetchImpl?: TokenFetch;
}

/**
 * Resolves the credential one stream call needs. Api-key endpoints return
 * the endpoint's key directly (byte-identical to the pre-#137 path).
 * Subscription endpoints read the auth store, proactively refresh tokens
 * inside the expiry window, persist the refreshed set, and return the
 * access token (for OpenAI: the re-minted API key, posture c).
 */
export async function resolveEndpointCredential(
  target: RouteTarget,
  opts: CredentialResolveOptions = {},
): Promise<string | EndpointAuthContext | undefined> {
  const endpoint = target.endpoint;
  if (endpoint.authKind !== "subscription") return endpoint.apiKey;

  const file = opts.configFile ?? userConfigFile();
  const now = opts.now ?? Date.now();
  const section = readAuthSection(file);
  const token = section.tokens[endpoint.name];
  if (!token) {
    throw new ProviderError(
      "auth",
      `no subscription credentials for endpoint "${endpoint.name}"; run \`moh provider login ${endpoint.name}\``,
    );
  }

  const exp = effectiveExpiry(token);
  if (exp !== undefined && exp - now < REFRESH_WINDOW_MS) {
    try {
      const fresh = await refreshToken(endpoint.kind, endpoint.name, token, section.overrides, opts);
      saveTokens(file, endpoint.name, fresh);
      return openaiCredentialFor(endpoint.kind, fresh);
    } catch (err) {
      throw new ProviderError(
        "auth",
        `${err instanceof Error ? err.message : String(err)}; run \`moh provider login ${endpoint.name}\``,
      );
    }
  }
  return openaiCredentialFor(endpoint.kind, token);
}

/** #151: OpenAI native grants (minted: false) ride the ChatGPT backend;
 * every other shape (including minted OpenAI keys) returns the plain
 * credential string, byte-identical to the pre-#151 path. */
function openaiCredentialFor(kind: string, token: AuthToken): string | EndpointAuthContext {
  if (kind === "openai" && token.grant?.minted === false) return openaiNativeAuthContext(token);
  return token.accessToken;
}

/**
 * The expiry the refresh window reads: OpenAI's stored `accessToken` is a
 * minted API key (no expiry) — the OAuth access token's expiry lives in
 * grant metadata as `oauthExpiresAt`. Everyone else uses `expiresAt`
 * (absent = unknown, used as-is).
 */
function effectiveExpiry(token: AuthToken): number | undefined {
  if (token.grant?.provider === "openai" && typeof token.grant.oauthExpiresAt === "number") {
    return token.grant.oauthExpiresAt;
  }
  return token.expiresAt;
}

async function refreshToken(
  kind: string,
  endpointName: string,
  token: AuthToken,
  overrides: AuthOverrides | undefined,
  opts: CredentialResolveOptions,
): Promise<AuthToken> {
  switch (kind) {
    case "anthropic":
      return refreshAnthropicToken(resolveAnthropicOAuthConfig(overrides?.anthropic), token, opts);
    case "google":
      return refreshGoogleToken(resolveGoogleOAuthConfig(overrides?.google), token, opts);
    case "openai":
      return refreshOpenaiToken(resolveOpenAiOAuthConfig(overrides?.openai), token, opts);
    default:
      throw new ProviderError(
        "auth",
        `endpoint "${endpointName}" is subscription-authed but its kind "${kind}" has no refresh grant; run \`moh provider login ${endpointName}\``,
      );
  }
}
