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
import type { AuthToken } from "./types";
import { refreshAnthropicToken, resolveAnthropicOAuthConfig } from "./anthropic";
import { refreshGoogleToken, resolveGoogleOAuthConfig } from "./google";
import { refreshOpenaiToken, resolveOpenAiOAuthConfig } from "./openai";

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
): Promise<string | undefined> {
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

  if (effectiveExpiry(token) !== undefined && effectiveExpiry(token)! - now < REFRESH_WINDOW_MS) {
    try {
      const fresh = await refreshToken(endpoint.kind, endpoint.name, token, section.overrides, opts);
      saveTokens(file, endpoint.name, fresh);
      return fresh.accessToken;
    } catch (err) {
      throw new ProviderError(
        "auth",
        `${err instanceof Error ? err.message : String(err)}; run \`moh provider login ${endpoint.name}\``,
      );
    }
  }
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
  overrides: import("./types").AuthOverrides | undefined,
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
