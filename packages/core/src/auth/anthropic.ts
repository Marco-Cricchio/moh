/**
 * Anthropic subscription grant: native OAuth tokens for Claude Pro/Max
 * (issue #134, spec docs/spec/oauth-subscription-auth.md). All endpoint /
 * client_id / scope facts verified against the local Claude Code source
 * copy (`constants/oauth.ts`, `services/oauth/*` — see
 * research/oauth-subscription-auth.md §1); Anthropic rotates hosts
 * without notice, so every captured value is overridable via
 * `auth.overrides.anthropic` in `~/.moh/config` (spec decision 5).
 *
 * Posture (spec decision 8): **native tokens only** — minting an API key
 * (`/api/oauth/claude_cli/create_api_key`) is deliberately rejected: the
 * minted key bills Console credits, not the Pro/Max plan.
 *
 * Long-lived inference-only tokens (spec decision 9): authorize with just
 * `user:inference` and a client-requested `expires_in`; if the server
 * rejects or limits that, we fall back silently to default-lifetime
 * tokens with the full scope set — refresh-before-stream (#137) covers
 * them like any other token.
 */
import type { AuthToken, AnthropicAuthOverrides } from "./types";
import {
  buildAuthorizeUrl,
  confirmToSWarning,
  generatePkce,
  generateState,
  raceForCode,
  startLoopbackCallback,
  type AuthorizationIo,
} from "./oauth";

/** Drift-prone captured values (re-verify against a fresh Claude Code copy). */
export const ANTHROPIC_OAUTH_DEFAULTS = {
  /** Pro/Max path; 307-bounces through claude.com for attribution. */
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  /** Hosted redirect page that displays a code to paste (headless path). */
  manualRedirectUrl: "https://platform.claude.com/oauth/code/callback",
  /** Requested lifetime for inference-only tokens: 1 year, seconds. */
  inferenceExpiresIn: 365 * 24 * 60 * 60,
} as const;

/** Scope of the long-lived inference-only token variant. */
export const ANTHROPIC_INFERENCE_SCOPE = "user:inference";

/** Full Claude.ai subscriber scope set (used at login fallback + refresh). */
export const ANTHROPIC_SUBSCRIPTION_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;

/** Injected on API calls whenever the endpoint is subscription-authed. */
export const ANTHROPIC_OAUTH_BETA = { "anthropic-beta": "oauth-2025-04-20" } as const;

export interface AnthropicOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  manualRedirectUrl: string;
  inferenceExpiresIn: number;
}

/** Defaults merged with user overrides (`auth.overrides.anthropic`). */
export function resolveAnthropicOAuthConfig(overrides?: AnthropicAuthOverrides): AnthropicOAuthConfig {
  return { ...ANTHROPIC_OAUTH_DEFAULTS, ...overrides };
}

/** Authorize URL for one redirect target (loopback or hosted manual page). */
export function buildAnthropicAuthorizeUrl(
  config: AnthropicOAuthConfig,
  opts: {
    codeChallenge: string;
    state: string;
    redirectUri: string;
    /** Long-lived inference-only variant: scope shrinks to user:inference. */
    inferenceOnly: boolean;
  },
): string {
  return buildAuthorizeUrl(config.authorizeUrl, {
    // `code=true` tells the login page to show the Claude Max upsell.
    code: "true",
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    scope: opts.inferenceOnly
      ? ANTHROPIC_INFERENCE_SCOPE
      : ANTHROPIC_SUBSCRIPTION_SCOPES.join(" "),
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
  });
}

/** HTTP seam for the token endpoint. Tests script it; production uses fetch. */
export type TokenEndpointFetch = (
  tokenUrl: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

export const defaultTokenEndpointFetch: TokenEndpointFetch = async (tokenUrl, body) => {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

interface AnthropicTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  account?: { uuid?: string; email_address?: string };
  organization?: { uuid?: string };
}

function parseScopes(scope: string | undefined): string[] | undefined {
  const scopes = scope?.split(" ").filter(Boolean);
  return scopes && scopes.length > 0 ? scopes : undefined;
}

/** Whether the granted scopes are just user:inference (the long-lived
 * inference-only variant) — recomputed from the response so the metadata
 * stays truthful after a scope-expanding refresh. */
function isInferenceOnlyGrant(scopes: string[] | undefined): boolean {
  return scopes !== undefined && scopes.every((s) => s === ANTHROPIC_INFERENCE_SCOPE);
}

function toAuthToken(
  response: AnthropicTokenResponse,
  opts: { inferenceOnly: boolean; now: number },
): AuthToken {
  const account = response.account;
  const scopes = parseScopes(response.scope);
  return {
    accessToken: response.access_token,
    ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
    ...(response.expires_in !== undefined
      ? { expiresAt: opts.now + response.expires_in * 1000 }
      : {}),
    ...(scopes ? { scopes } : {}),
    ...(account && (account.uuid || account.email_address)
      ? {
          account: {
            ...(account.uuid ? { id: account.uuid } : {}),
            ...(account.email_address ? { email: account.email_address } : {}),
          },
        }
      : {}),
    grant: { inferenceOnly: opts.inferenceOnly && isInferenceOnlyGrant(scopes) },
    updatedAt: opts.now,
  };
}

/**
 * Authorization-code exchange. With `inferenceOnly`, requests the
 * long-lived token via a client-requested `expires_in`; if the server
 * rejects that, retries once without it — the silent fallback to
 * default-lifetime tokens (spec decision 9), same authorized scopes.
 * (The exchange body carries no `scope`, mirroring Claude Code: scopes
 * are fixed by the authorize request, and the code was issued for the
 * loopback or manual redirect as raced in loginAnthropic.) A server-side
 * cap on `expires_in` (success with a shorter lifetime) is accepted
 * as-is: the token simply rides normal refresh.
 */
export async function exchangeAnthropicCode(
  config: AnthropicOAuthConfig,
  opts: {
    code: string;
    codeVerifier: string;
    state: string;
    redirectUri: string;
    inferenceOnly: boolean;
    fetchImpl?: TokenEndpointFetch;
    now?: number;
  },
): Promise<AuthToken> {
  const fetchImpl = opts.fetchImpl ?? defaultTokenEndpointFetch;
  const now = opts.now ?? Date.now();
  const base = {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: config.clientId,
    code_verifier: opts.codeVerifier,
    state: opts.state,
  };
  const attempt = async (longLived: boolean): Promise<{ status: number; json: Record<string, unknown> }> =>
    fetchImpl(config.tokenUrl, {
      ...base,
      ...(longLived ? { expires_in: config.inferenceExpiresIn } : {}),
    });

  let longLived = opts.inferenceOnly;
  let result = await attempt(longLived);
  if (longLived && result.status !== 200) {
    // Server rejected the long-lived request: silent fallback — same code,
    // same authorized scopes, default lifetime (normal refresh covers it).
    longLived = false;
    result = await attempt(false);
  }
  if (result.status !== 200) {
    throw new Error(`Anthropic token exchange failed (${result.status}): ${JSON.stringify(result.json)}`);
  }
  return toAuthToken(result.json as unknown as AnthropicTokenResponse, { inferenceOnly: opts.inferenceOnly, now });
}

/**
 * Refresh grant before stream (#137 wires this into route resolution).
 * The backend allows scope expansion on refresh and may rotate the
 * refresh token; when the response omits it, the old one is kept.
 * Account info carries over from the stored token.
 */
export async function refreshAnthropicToken(
  config: AnthropicOAuthConfig,
  token: AuthToken,
  opts: { fetchImpl?: TokenEndpointFetch; now?: number } = {},
): Promise<AuthToken> {
  if (!token.refreshToken) {
    throw new Error("Anthropic token has no refresh token; run `moh provider login`");
  }
  const fetchImpl = opts.fetchImpl ?? defaultTokenEndpointFetch;
  const now = opts.now ?? Date.now();
  const result = await fetchImpl(config.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: config.clientId,
    scope: (token.scopes ?? ANTHROPIC_SUBSCRIPTION_SCOPES).join(" "),
  });
  if (result.status !== 200) {
    throw new Error(`Anthropic token refresh failed (${result.status}); run \`moh provider login\``);
  }
  const response = result.json as unknown as AnthropicTokenResponse;
  const fresh = toAuthToken(response, { inferenceOnly: token.grant?.inferenceOnly === true, now });
  return {
    ...fresh,
    ...(fresh.refreshToken ? {} : { refreshToken: token.refreshToken }),
    account: fresh.account ?? token.account,
  };
}

/** Thrown by {@link loginAnthropic} when the user declines the ToS warning. */
export class AnthropicLoginAborted extends Error {
  constructor() {
    super("subscription auth aborted: terms of service not acknowledged");
    this.name = "AnthropicLoginAborted";
  }
}

/**
 * The full interactive Anthropic login: ToS acknowledgement (spec
 * invariant 4), PKCE + loopback callback raced against the hosted
 * manual-redirect paste path (headless-first), then the code exchange
 * with the long-lived inference-only request and silent fallback.
 */
export async function loginAnthropic(
  io: AuthorizationIo,
  opts: {
    overrides?: AnthropicAuthOverrides;
    fetchImpl?: TokenEndpointFetch;
    now?: number;
    timeoutMs?: number;
  } = {},
): Promise<AuthToken> {
  if (!(await confirmToSWarning(io))) throw new AnthropicLoginAborted();

  const config = resolveAnthropicOAuthConfig(opts.overrides);
  const pkce = generatePkce();
  const state = generateState();
  const callback = await startLoopbackCallback({ state, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });

  const shared = { codeChallenge: pkce.challenge, state, inferenceOnly: true };
  const authorizeUrl = buildAnthropicAuthorizeUrl(config, { ...shared, redirectUri: callback.redirectUri });
  const manualUrl = buildAnthropicAuthorizeUrl(config, { ...shared, redirectUri: config.manualRedirectUrl });

  const code = await raceForCode(io, { authorizeUrl, manualUrl, callback });
  if (code === "") {
    throw new Error("Anthropic login failed: no authorization code received (cancelled or timed out)");
  }
  // The winning path decides the exchange's redirect_uri — the code was
  // issued for the loopback listener or for the hosted manual page.
  const redirectUri = callback.deliveredViaCallback ? callback.redirectUri : config.manualRedirectUrl;
  return exchangeAnthropicCode(config, {
    code,
    codeVerifier: pkce.verifier,
    state,
    redirectUri,
    inferenceOnly: true,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
