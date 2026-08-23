/**
 * Google subscription grant: personal Google account via the Gemini CLI
 * login (issue #136, spec docs/spec/oauth-subscription-auth.md). All
 * endpoint / client / protocol facts verified against the
 * google-gemini/gemini-cli source (`packages/core/src/code_assist/oauth2.ts`
 * — see research/oauth-subscription-auth.md §3); Google rotates values
 * without notice, so every captured value is overridable via
 * `auth.overrides.google` in `~/.moh/config` (spec decision 5).
 *
 * Posture (spec decision 8): **native tokens** — the access token rides
 * subscription auth against the Code Assist internal API
 * (`https://cloudcode-pa.googleapis.com/v1internal`); no key minting.
 *
 * Two flows, exactly as gemini-cli offers them:
 * - **browser**: loopback callback bound to the IP literal `127.0.0.1`
 *   with an OS-assigned ephemeral port (Google's "Desktop app" client
 *   policy requires a loopback IP literal), state-only CSRF (no PKCE on
 *   this path — mirrors the source);
 * - **manual paste** (headless / NO_BROWSER): redirect to the out-of-band
 *   page `https://codeassist.google.com/authcode` that displays the code,
 *   **with PKCE S256**.
 *
 * `loginGoogle` races both (the generic manual-paste race): show the
 * manual URL *and* try the browser; the winning path decides the
 * exchange's `redirect_uri` and whether `code_verifier` is sent.
 *
 * Token storage is file-only v1 (spec decision 10); refresh is core-owned
 * refresh-before-stream (#137 wires it into route resolution).
 */
import type { AuthToken, GoogleAuthOverrides } from "./types";
import {
  buildAuthorizeUrl,
  confirmToSWarning,
  generatePkce,
  generateState,
  raceForCode,
  startLoopbackCallback,
  type AuthorizationIo,
} from "./oauth";

/** Drift-prone captured values (re-verify against a fresh gemini-cli checkout). */
export const GOOGLE_OAUTH_DEFAULTS = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  /**
   * Embedded intentionally, mirroring gemini-cli: Google's OAuth guidance
   * for installed apps treats the client_secret as "obviously not ... a
   * secret" (developers.google.com/identity/protocols/oauth2#installed).
   */
  clientSecret: "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",
  /** Out-of-band page that displays the code to paste (headless path). */
  manualRedirectUrl: "https://codeassist.google.com/authcode",
} as const;

/** Gemini CLI's scope set (oauth2.ts OAUTH_SCOPE). */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

/** Code Assist internal API used when subscription-authed (research §3).
 * Wired into the provider adapter by #137. */
export const GOOGLE_API_BASE_URL = "https://cloudcode-pa.googleapis.com/v1internal";

export interface GoogleOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  manualRedirectUrl: string;
}

/** Defaults merged with user overrides (`auth.overrides.google`). */
export function resolveGoogleOAuthConfig(overrides?: GoogleAuthOverrides): GoogleOAuthConfig {
  return { ...GOOGLE_OAUTH_DEFAULTS, ...overrides };
}

/**
 * Authorize URL for one redirect target. `codeChallenge` is set only on
 * the manual path (gemini-cli uses PKCE there, state-only on browser);
 * `access_type=offline` always, so a refresh token comes back.
 */
export function buildGoogleAuthorizeUrl(
  config: GoogleOAuthConfig,
  opts: { state: string; redirectUri: string; codeChallenge?: string },
): string {
  return buildAuthorizeUrl(config.authorizeUrl, {
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    // Guarantees the refresh_token comes back: without a consent prompt
    // Google omits it on repeat grants for the same account, which would
    // make re-login (the documented recovery path) return no refresh
    // token either — breaking core-owned refresh (spec decision 6).
    prompt: "consent",
    ...(opts.codeChallenge ? { code_challenge: opts.codeChallenge, code_challenge_method: "S256" } : {}),
    state: opts.state,
  });
}

/** HTTP seam for the token endpoint. Tests script it; production uses fetch. */
export type GoogleEndpointFetch = (
  tokenUrl: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

export const defaultGoogleEndpointFetch: GoogleEndpointFetch = async (tokenUrl, body) => {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // Standard google-auth-library form encoding; JSON also works on the
    // Google token endpoint, but form is the library's captured shape.
    body: new URLSearchParams(body as Record<string, string>).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  /** Carries email/name claims (decoded display-only, like openai.ts). */
  id_token?: string;
}

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

function toAuthToken(response: GoogleTokenResponse, opts: { now: number }): AuthToken {
  const claims = response.id_token ? decodeJwtPayload(response.id_token) : undefined;
  const email = typeof claims?.email === "string" ? claims.email : undefined;
  const name = typeof claims?.name === "string" ? claims.name : undefined;
  const scopes = response.scope?.split(" ").filter(Boolean);
  return {
    accessToken: response.access_token,
    ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
    ...(response.expires_in !== undefined
      ? { expiresAt: opts.now + response.expires_in * 1000 }
      : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
    ...(email || name
      ? { account: { ...(email ? { email } : {}), ...(name ? { name } : {}) } }
      : {}),
    grant: { provider: "google" },
    updatedAt: opts.now,
  };
}

/**
 * Authorization-code exchange. `codeVerifier` is sent only when the code
 * arrived via the manual-paste path (PKCE is used there, not on the
 * browser path). Google may omit `refresh_token` on repeat grants from
 * the same account — the stored absence is honored as-is; re-login
 * (`moh provider login`) is the recovery path.
 */
export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  opts: {
    code: string;
    redirectUri: string;
    /** Present only when the code was pasted (manual path, PKCE S256). */
    codeVerifier?: string;
    fetchImpl?: GoogleEndpointFetch;
    now?: number;
  },
): Promise<AuthToken> {
  const fetchImpl = opts.fetchImpl ?? defaultGoogleEndpointFetch;
  const now = opts.now ?? Date.now();
  const result = await fetchImpl(config.tokenUrl, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...(opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}),
  });
  if (result.status !== 200 || typeof result.json.access_token !== "string") {
    throw new Error(`Google token exchange failed (${result.status}): ${JSON.stringify(result.json)}`);
  }
  const response = {
    access_token: result.json.access_token,
    ...(typeof result.json.refresh_token === "string" ? { refresh_token: result.json.refresh_token } : {}),
    ...(typeof result.json.expires_in === "number" ? { expires_in: result.json.expires_in } : {}),
    ...(typeof result.json.scope === "string" ? { scope: result.json.scope } : {}),
    ...(typeof result.json.id_token === "string" ? { id_token: result.json.id_token } : {}),
  };
  return toAuthToken(response, { now });
}

/**
 * Refresh grant before stream (#137 wires this into route resolution).
 * Standard google-auth-library shape: client_id + client_secret, no PKCE.
 * A rotated refresh token wins; an omitted one keeps the old. Account
 * info carries over from the stored token.
 */
export async function refreshGoogleToken(
  config: GoogleOAuthConfig,
  token: AuthToken,
  opts: { fetchImpl?: GoogleEndpointFetch; now?: number } = {},
): Promise<AuthToken> {
  if (!token.refreshToken) {
    throw new Error("Google token has no refresh token; run `moh provider login`");
  }
  const fetchImpl = opts.fetchImpl ?? defaultGoogleEndpointFetch;
  const now = opts.now ?? Date.now();
  const result = await fetchImpl(config.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (result.status !== 200 || typeof result.json.access_token !== "string") {
    throw new Error(`Google token refresh failed (${result.status}); run \`moh provider login\``);
  }
  const response: GoogleTokenResponse = {
    access_token: result.json.access_token,
    ...(typeof result.json.refresh_token === "string" ? { refresh_token: result.json.refresh_token } : {}),
    ...(typeof result.json.expires_in === "number" ? { expires_in: result.json.expires_in } : {}),
    ...(typeof result.json.scope === "string" ? { scope: result.json.scope } : {}),
    ...(typeof result.json.id_token === "string" ? { id_token: result.json.id_token } : {}),
  };
  const fresh = toAuthToken(response, { now });
  return {
    ...fresh,
    ...(fresh.refreshToken ? {} : { refreshToken: token.refreshToken }),
    account: fresh.account ?? token.account,
  };
}

/** Thrown by {@link loginGoogle} when the user declines the ToS warning. */
export class GoogleLoginAborted extends Error {
  constructor() {
    super("subscription auth aborted: terms of service not acknowledged");
    this.name = "GoogleLoginAborted";
  }
}

/**
 * The full interactive Google login: ToS acknowledgement (spec invariant
 * 4), then the manual-paste race — the manual authorize URL (PKCE +
 * authcode redirect page) is shown while `openUrl` tries the browser
 * variant (state-only + loopback `127.0.0.1` ephemeral-port callback).
 * Whichever delivers a code first wins; the winning path decides the
 * exchange's `redirect_uri` and `code_verifier` presence.
 */
export async function loginGoogle(
  io: AuthorizationIo,
  opts: {
    overrides?: GoogleAuthOverrides;
    fetchImpl?: GoogleEndpointFetch;
    now?: number;
    timeoutMs?: number;
  } = {},
): Promise<AuthToken> {
  if (!(await confirmToSWarning(io))) throw new GoogleLoginAborted();

  const config = resolveGoogleOAuthConfig(opts.overrides);
  const state = generateState();
  // PKCE pair for the manual path (the browser path is state-only, per
  // gemini-cli's captured behavior).
  const pkce = generatePkce();
  const callback = await startLoopbackCallback({
    state,
    // Loopback IP literal, not "localhost" — Google's "Desktop app"
    // redirect policy requires the IP literal form.
    host: "127.0.0.1",
    callbackPath: "/oauth2callback",
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const authorizeUrl = buildGoogleAuthorizeUrl(config, {
    state,
    redirectUri: callback.redirectUri,
  });
  const manualUrl = buildGoogleAuthorizeUrl(config, {
    state,
    redirectUri: config.manualRedirectUrl,
    codeChallenge: pkce.challenge,
  });

  const code = await raceForCode(io, { authorizeUrl, manualUrl, callback });
  if (code === "") {
    throw new Error("Google login failed: no authorization code received (cancelled or timed out)");
  }
  const viaCallback = callback.deliveredViaCallback;
  return exchangeGoogleCode(config, {
    code,
    redirectUri: viaCallback ? callback.redirectUri : config.manualRedirectUrl,
    ...(viaCallback ? {} : { codeVerifier: pkce.verifier }),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
