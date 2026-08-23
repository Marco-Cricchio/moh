/**
 * OpenAI subscription grant: ChatGPT Plus/Pro via the Codex CLI login
 * (issue #135, spec docs/spec/oauth-subscription-auth.md). All endpoint /
 * client_id / protocol facts verified against the openai/codex source
 * (`codex-rs/login/src/server.rs`, `device_code_auth.rs`,
 * `auth/manager.rs` — see research/oauth-subscription-auth.md §2);
 * OpenAI rotates values without notice, so every captured value is
 * overridable via `auth.overrides.openai` in `~/.moh/config`
 * (spec decision 5).
 *
 * Posture (c), amended by #151: after the normal authorization-code
 * exchange, an **RFC 8693 token exchange** (`requested_token=openai-api-key`,
 * subject = the id_token) mints an API key **best-effort** — codex
 * itself tolerates mint failure (`obtain_api_key(...).ok()`), and accounts
 * whose id_token lacks organization/workspace claims cannot mint. When the
 * mint succeeds the key rides the existing api-key path; when it fails we
 * continue with the **native OAuth tokens** (grant `minted: false`) and
 * streaming goes through the ChatGPT backend (`CHATGPT_CODEX_BASE_URL`,
 * Responses API wire, `originator` header like codex).
 * issuer and client_id are user-overridable (spec decision 5); the
 * ports/callbackPath allowlist values are captured-only.
 *
 * Headless (spec decision 4): OpenAI offers a **custom device-code flow**
 * (POST `{issuer}/deviceauth/usercode`, poll `{issuer}/deviceauth/token` —
 * not RFC 8628 endpoints). `loginOpenAI` offers both paths; the loopback
 * path binds the Codex allowlist ports 1455 → 1457 with callback path
 * `/auth/callback`.
 */
import type { AuthToken, OpenAiAuthOverrides } from "./types";
import {
  buildAuthorizeUrl,
  confirmToSWarning,
  generatePkce,
  generateState,
  startLoopbackCallback,
  type AuthorizationIo,
  CODE_RECEIVED_MSG,
} from "./oauth";

/** Drift-prone captured values (re-verify against a fresh codex checkout). */
export const OPENAI_OAUTH_DEFAULTS = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  /** Redirect-URI allowlist ports, in bind order (1455, fallback 1457). */
  ports: [1455, 1457] as const,
  /** Allowlisted callback path (not the generic /callback). */
  callbackPath: "/auth/callback",
} as const;

/** Codex CLI's scope set (server.rs build_authorize_url). */
export const OPENAI_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
] as const;

/** RFC 8693 constants (server.rs obtain_api_key). */
export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const REQUESTED_TOKEN = "openai-api-key";
export const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

/** Codex CLI's originator header value (also sent to the ChatGPT backend). */
export const CHATGPT_CODEX_ORIGINATOR = "codex_cli_rs";

/** ChatGPT-mode backend used when subscription-authed (research §2). */
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface OpenAiOAuthConfig {
  issuer: string;
  clientId: string;
  ports: readonly number[];
  callbackPath: string;
}

/** Defaults merged with user overrides (`auth.overrides.openai`). */
export function resolveOpenAiOAuthConfig(overrides?: OpenAiAuthOverrides): OpenAiOAuthConfig {
  return { ...OPENAI_OAUTH_DEFAULTS, ...overrides };
}

/** Authorize URL for the loopback redirect (Codex's extra params kept). */
export function buildOpenaiAuthorizeUrl(
  config: OpenAiOAuthConfig,
  opts: { codeChallenge: string; state: string; redirectUri: string },
): string {
  return buildAuthorizeUrl(`${config.issuer}/oauth/authorize`, {
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    scope: OPENAI_SCOPES.join(" "),
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });
}

/** HTTP seam for all OpenAI auth endpoints. Tests script it; production uses fetch. */
export type OpenAiEndpointFetch = (
  url: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

export const defaultOpenAiEndpointFetch: OpenAiEndpointFetch = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

interface OpenAiTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/** Namespaced id_token claim prefixes (token_data.rs IdClaims). */
const PROFILE_CLAIM = "https://api.openai.com/profile";
const AUTH_CLAIM = "https://api.openai.com/auth";

/** Best-effort id_token payload decode (unverified display-only claims). */
function decodeJwtPayload(idToken: string): Record<string, unknown> | undefined {
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Shared claim extraction (email + plan) from the id_token payload. */
function idTokenClaims(idToken: string | undefined): { email?: string; plan?: string } {
  const claims = idToken ? decodeJwtPayload(idToken) : undefined;
  const profile = claims?.[PROFILE_CLAIM] as Record<string, unknown> | undefined;
  const auth = claims?.[AUTH_CLAIM] as Record<string, unknown> | undefined;
  return {
    email: typeof profile?.email === "string" ? profile.email : undefined,
    plan: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
  };
}

/** Minted key up front, OAuth set + plan in grant. The OAuth access
 * token's expiry (from `expires_in`) is recorded as `oauthExpiresAt` in
 * grant metadata — the minted API key itself doesn't expire, but #137's
 * proactive refresh window needs it to decide when to re-mint. */
function toMintedAuthToken(
  mintedKey: string,
  tokens: OpenAiTokenResponse,
  opts: { now: number },
): AuthToken {
  const { email, plan } = idTokenClaims(tokens.id_token);
  return {
    // The minted API key rides the existing api-key path (posture c).
    accessToken: mintedKey,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    // API keys don't expire; OAuth access-token expiry is kept in grant
    // metadata so a future re-mint can decide freshness.
    ...(tokens.access_token
      ? { grant: { provider: "openai", minted: true, oauthAccessToken: tokens.access_token, ...(tokens.expires_in !== undefined ? { oauthExpiresAt: opts.now + tokens.expires_in * 1000 } : {}), ...(tokens.id_token ? { idToken: tokens.id_token } : {}), ...(plan ? { plan } : {}) } }
      : {}),
    ...(email ? { account: { email } } : {}),
    updatedAt: opts.now,
  };
}

/** Native (un-minted) grant: OAuth access token up front, minted:false.
 * Streaming for this shape goes through the ChatGPT backend with the
 * OAuth access token as the bearer credential (#151). */
function toNativeAuthToken(tokens: OpenAiTokenResponse, opts: { now: number }): AuthToken {
  const { email, plan } = idTokenClaims(tokens.id_token);
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.expires_in !== undefined ? { expiresAt: opts.now + tokens.expires_in * 1000 } : {}),
    grant: { provider: "openai", minted: false, ...(tokens.id_token ? { idToken: tokens.id_token } : {}), ...(plan ? { plan } : {}) },
    ...(email ? { account: { email } } : {}),
    updatedAt: opts.now,
  };
}

/** Authorization-code exchange (server.rs exchange_code_for_tokens).
 * The RFC 8693 mint is best-effort (#151): on failure the returned
 * `auth` is the native token set (`grant.minted: false`) and
 * `mintError` carries the reason so callers can warn. */
export async function exchangeOpenaiCode(
  config: OpenAiOAuthConfig,
  opts: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    fetchImpl?: OpenAiEndpointFetch;
    now?: number;
  },
): Promise<{ token: OpenAiTokenResponse; auth: AuthToken; mintError?: string }> {
  const fetchImpl = opts.fetchImpl ?? defaultOpenAiEndpointFetch;
  const now = opts.now ?? Date.now();
  const result = await fetchImpl(`${config.issuer}/oauth/token`, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: config.clientId,
    code_verifier: opts.codeVerifier,
    scope: OPENAI_SCOPES.join(" "),
  });
  if (result.status !== 200 || typeof result.json.access_token !== "string") {
    throw new Error(`OpenAI token exchange failed (${result.status}): ${JSON.stringify(result.json)}`);
  }
  const tokens = {
    access_token: result.json.access_token,
    ...(typeof result.json.refresh_token === "string" ? { refresh_token: result.json.refresh_token } : {}),
    ...(typeof result.json.id_token === "string" ? { id_token: result.json.id_token } : {}),
    ...(typeof result.json.expires_in === "number" ? { expires_in: result.json.expires_in } : {}),
  };
  // #151: mint best-effort — codex tolerates failure; accounts without
  // organization claims in the id_token cannot mint and still work via
  // the ChatGPT backend with the native tokens.
  try {
    const mintedKey = await exchangeOpenaiApiKey(config, tokens, { fetchImpl });
    return { token: tokens, auth: toMintedAuthToken(mintedKey, tokens, { now }) };
  } catch (err) {
    return {
      token: tokens,
      auth: toNativeAuthToken(tokens, { now }),
      mintError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * RFC 8693 token exchange: `requested_token=openai-api-key`,
 * subject_token = the id_token. Returns the API-key-shaped access_token.
 */
export async function exchangeOpenaiApiKey(
  config: OpenAiOAuthConfig,
  tokens: { id_token?: string },
  opts: { fetchImpl?: OpenAiEndpointFetch } = {},
): Promise<string> {
  if (!tokens.id_token) {
    throw new Error("OpenAI token exchange needs an id_token; run `moh provider login` again");
  }
  const fetchImpl = opts.fetchImpl ?? defaultOpenAiEndpointFetch;
  const result = await fetchImpl(`${config.issuer}/oauth/token`, {
    grant_type: TOKEN_EXCHANGE_GRANT,
    requested_token: REQUESTED_TOKEN,
    subject_token: tokens.id_token,
    subject_token_type: ID_TOKEN_TYPE,
    client_id: config.clientId,
  });
  if (result.status !== 200 || typeof result.json.access_token !== "string") {
    throw new Error(`OpenAI API-key mint failed (${result.status}): ${JSON.stringify(result.json)}`);
  }
  return result.json.access_token;
}

/**
 * Refresh grant before re-mint (#137 wires this into route resolution).
 * Codex refreshes when the JWT expires within a 5-minute window; the
 * refresh response is a normal token set (may rotate the refresh token,
 * may omit it — the old one is kept). The returned AuthToken carries a
 * freshly re-minted API key as its accessToken (posture c).
 */
export async function refreshOpenaiToken(
  config: OpenAiOAuthConfig,
  token: AuthToken,
  opts: { fetchImpl?: OpenAiEndpointFetch; now?: number } = {},
): Promise<AuthToken> {
  if (!token.refreshToken) {
    throw new Error("OpenAI token has no refresh token; run `moh provider login`");
  }
  const fetchImpl = opts.fetchImpl ?? defaultOpenAiEndpointFetch;
  const now = opts.now ?? Date.now();
  const result = await fetchImpl(`${config.issuer}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: config.clientId,
    scope: OPENAI_SCOPES.join(" "),
  });
  if (result.status !== 200 || typeof result.json.access_token !== "string") {
    throw new Error(`OpenAI token refresh failed (${result.status}); run \`moh provider login\``);
  }
  const refreshToken =
    typeof result.json.refresh_token === "string" ? result.json.refresh_token : token.refreshToken;
  const idToken: string | undefined =
    typeof result.json.id_token === "string"
      ? result.json.id_token
      : typeof token.grant?.idToken === "string"
        ? token.grant.idToken
        : undefined;
  const tokens: OpenAiTokenResponse = {
    access_token: result.json.access_token,
    refresh_token: refreshToken,
    ...(idToken ? { id_token: idToken } : {}),
    ...(typeof result.json.expires_in === "number" ? { expires_in: result.json.expires_in } : {}),
  };
  // #151: a stored native grant (minted: false) treats re-mint failure as
  // non-fatal — the fresh native tokens still work via the ChatGPT
  // backend. A previously-minted grant keeps the fatal re-mint (its
  // consumers ride the api-key path and have no native fallback stored).
  if (token.grant?.minted === false) {
    try {
      const mintedKey = await exchangeOpenaiApiKey(config, tokens, { fetchImpl });
      const fresh = toMintedAuthToken(mintedKey, tokens, { now });
      return { ...fresh, account: fresh.account ?? token.account };
    } catch {
      const fresh = toNativeAuthToken(tokens, { now });
      return { ...fresh, account: fresh.account ?? token.account };
    }
  }
  const mintedKey = await exchangeOpenaiApiKey(config, tokens, { fetchImpl });
  const fresh = toMintedAuthToken(mintedKey, tokens, { now });
  return { ...fresh, account: fresh.account ?? token.account };
}

/** Warn about a skipped mint (#151): OnboardingIo has no warn channel,
 * so the warning rides `info` with an explicit prefix. */
async function warnMintSkipped(io: AuthorizationIo, mintError: string): Promise<void> {
  await io.info(`warning: API-key mint skipped (${mintError}); continuing with native ChatGPT-plan tokens`);
}

/** Thrown by {@link loginOpenAI} when the user declines the ToS warning. */
export class OpenAiLoginAborted extends Error {
  constructor() {
    super("subscription auth aborted: terms of service not acknowledged");
    this.name = "OpenAiLoginAborted";
  }
}

/** Custom device-code flow, step 1 (device_code_auth.rs): request a user
 * code, binding it to our PKCE challenge. */
export async function requestOpenaiUserCode(
  config: OpenAiOAuthConfig,
  opts: { codeChallenge: string; fetchImpl?: OpenAiEndpointFetch },
): Promise<{ userCode: string; deviceAuthId: string; verificationUri?: string }> {
  const fetchImpl = opts.fetchImpl ?? defaultOpenAiEndpointFetch;
  const result = await fetchImpl(`${config.issuer}/deviceauth/usercode`, {
    client_id: config.clientId,
    scope: OPENAI_SCOPES.join(" "),
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  if (
    result.status !== 200 ||
    typeof result.json.user_code !== "string" ||
    typeof result.json.device_auth_id !== "string"
  ) {
    throw new Error(`OpenAI device-code request failed (${result.status}): ${JSON.stringify(result.json)}`);
  }
  const uri = result.json.verification_uri ?? result.json.verification_url;
  return {
    userCode: result.json.user_code,
    deviceAuthId: result.json.device_auth_id,
    ...(typeof uri === "string" ? { verificationUri: uri } : {}),
  };
}

/** Custom device-code flow, step 2: poll until an authorization code is
 * returned. `pendingStatuses` decides which non-code payloads mean "keep
 * waiting" (the custom protocol is not RFC 8628; Codex treats a missing
 * `authorization_code` as pending). The poll response may carry a
 * server-side `code_verifier` (research §2) — returned so the exchange
 * uses whichever verifier the code was actually issued for. Returns
 * `code: ""` on timeout. */
export async function pollOpenaiDeviceToken(
  config: OpenAiOAuthConfig,
  device: { deviceAuthId: string; userCode: string },
  opts: {
    fetchImpl?: OpenAiEndpointFetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ code: string; codeVerifier?: string }> {
  const fetchImpl = opts.fetchImpl ?? defaultOpenAiEndpointFetch;
  const interval = opts.pollIntervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const result = await fetchImpl(`${config.issuer}/deviceauth/token`, {
      device_auth_id: device.deviceAuthId,
      user_code: device.userCode,
    });
    if (result.status === 200 && typeof result.json.authorization_code === "string") {
      return {
        code: result.json.authorization_code,
        ...(typeof result.json.code_verifier === "string" ? { codeVerifier: result.json.code_verifier } : {}),
      };
    }
    // Non-200 that isn't "still waiting" fails fast.
    if (result.status !== 200 && result.status !== 400 && result.status !== 429) {
      throw new Error(`OpenAI device-code polling failed (${result.status}): ${JSON.stringify(result.json)}`);
    }
    if (typeof result.json.error === "string" && result.json.error !== "authorization_pending" && result.json.error !== "slow_down") {
      throw new Error(`OpenAI device-code polling error: ${result.json.error}`);
    }
    // slow_down: back off before the next poll (RFC 8628 semantics,
    // applied to the custom protocol too).
    await sleep(result.json.error === "slow_down" ? interval * 2 : interval);
  }
  return { code: "" };
}

/**
 * The full interactive OpenAI login: ToS acknowledgement (spec invariant
 * 4), then the user picks the path — browser (loopback on the Codex
 * allowlist ports) or device code (headless-native, spec decision 4).
 * Whichever path delivers the authorization code, the same PKCE pair is
 * used for the exchange, then the RFC 8693 exchange mints the API key
 * (best-effort, #151: mint failure warns and keeps the native tokens).
 */
export async function loginOpenAI(
  io: AuthorizationIo,
  opts: {
    overrides?: OpenAiAuthOverrides;
    fetchImpl?: OpenAiEndpointFetch;
    now?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    /** Injectable sleep (tests); default Bun.sleep. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<AuthToken> {
  if (!(await confirmToSWarning(io))) throw new OpenAiLoginAborted();

  const config = resolveOpenAiOAuthConfig(opts.overrides);
  const pkce = generatePkce();
  const state = generateState();
  const answer = (await io.ask("Authorize in your browser? (y = browser, n = device code for headless): "))
    .trim()
    .toLowerCase();

  let code: string;
  let codeVerifier: string;
  if (answer === "n") {
    // Headless-native: custom device-code flow (no local server at all).
    const device = await requestOpenaiUserCode(config, { codeChallenge: pkce.challenge, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    await io.info(
      `Open the verification page and enter this code:\n  ${device.verificationUri ?? `${config.issuer}/device`}\n  code: ${device.userCode}`,
    );
    const polled = await pollOpenaiDeviceToken(config, device, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    if (polled.code === "") {
      throw new Error("OpenAI login failed: device code timed out or was denied");
    }
    code = polled.code;
    // The poll may carry the server-side verifier the code was issued for.
    codeVerifier = polled.codeVerifier ?? pkce.verifier;
    // Device-flow codes go through the same "normal code exchange" as the
    // browser flow (research §2), redirect_uri included per Codex's shape.
    const redirectUri = `http://localhost:${config.ports[0]}${config.callbackPath}`;
    const { auth, mintError } = await exchangeOpenaiCode(config, {
      code,
      codeVerifier,
      redirectUri,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    if (mintError) await warnMintSkipped(io, mintError);
    return auth;
  }

  const callback = await startLoopbackCallback({
    state,
    ports: [...config.ports],
    callbackPath: config.callbackPath,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const authorizeUrl = buildOpenaiAuthorizeUrl(config, {
    codeChallenge: pkce.challenge,
    state,
    redirectUri: callback.redirectUri,
  });
  await io.info(
    `Authorize in your browser:\n  ${authorizeUrl}\n` +
      `If it did not open automatically, copy the URL into a browser on any machine.`,
  );
  if (io.openUrl) {
    try {
      await io.openUrl(authorizeUrl);
    } catch {
      // Best-effort: headless boxes have no browser (device code is the
      // dedicated path there, but the user chose this one — URL shown above).
    }
  }
  try {
    code = await callback.code;
    await io.info(CODE_RECEIVED_MSG);
  } catch (err) {
    throw new Error(`OpenAI login failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    callback.cancel();
  }
  const { auth, mintError } = await exchangeOpenaiCode(config, {
    code,
    codeVerifier: pkce.verifier,
    redirectUri: callback.redirectUri,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  if (mintError) await warnMintSkipped(io, mintError);
  return auth;
}
