/**
 * xAI subscription grant (issue #163, ADR-0010). Primary source: pi-ai
 * `auth/oauth/xai.js` (MIT, 0.84.2): custom device flow against
 * auth.x.ai, refresh with rotation tolerance (a missing refresh_token
 * keeps the previous one), expiry skewed 5 minutes early so a token
 * never dies mid-request. Backend: https://api.x.ai/v1, openai wire
 * (already wired by #159).
 */
import type { AuthToken, XaiAuthOverrides } from "./types";
import { confirmToSWarningFor, type AuthorizationIo } from "./oauth";
import { pollDeviceCodeFlow, type DeviceFlowClock, type DevicePollOptions, type DevicePollResult } from "./device-code";

export const XAI_OAUTH_DEFAULTS = {
  deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
} as const;

/** pi's scope set (offline_access = refresh token). */
export const XAI_SCOPES = "openid profile email offline_access grok-cli:access api:access";

/** The xAI backend (openai wire, #159 defaults). */
export const XAI_API_BASE_URL = "https://api.x.ai/v1";

/** Refresh slightly before the reported expiry (pi's REFRESH_SKEW_MS). */
export const XAI_REFRESH_SKEW_MS = 5 * 60 * 1000;
/** pi's fallback when the token response omits expires_in. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

export interface XaiOAuthConfig {
  deviceCodeUrl: string;
  tokenUrl: string;
  clientId: string;
}

/** Defaults merged with user overrides (`auth.overrides.xai`). */
export function resolveXaiOAuthConfig(overrides?: XaiAuthOverrides): XaiOAuthConfig {
  return { ...XAI_OAUTH_DEFAULTS, ...overrides };
}

/** HTTP seam for the form-encoded OAuth endpoints (test seam). */
export type XaiEndpointFetch = (
  url: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

export const defaultXaiEndpointFetch: XaiEndpointFetch = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body as Record<string, string>).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds: number;
}

/** The verification URI is opened in a browser; only https is trusted. */
function validateVerificationUri(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  if (url.protocol !== "https:") throw new Error("Untrusted verification URI in xAI OAuth response");
  return url.href;
}

async function requestDeviceCode(config: XaiOAuthConfig, fetchImpl: XaiEndpointFetch): Promise<DeviceCode> {
  const result = await fetchImpl(config.deviceCodeUrl, {
    client_id: config.clientId,
    scope: XAI_SCOPES,
    referrer: "moh",
  });
  const body = result.json;
  const deviceCode = body.device_code;
  const userCode = body.user_code;
  if (result.status !== 200 || typeof deviceCode !== "string" || typeof userCode !== "string") {
    throw new Error(`xAI device authorization failed (HTTP ${result.status}): ${JSON.stringify(body)}`);
  }
  const interval = body.interval;
  const expiresIn = body.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`Invalid xAI OAuth response field: expires_in`);
  }
  return {
    deviceCode,
    userCode,
    verificationUri: validateVerificationUri(body.verification_uri, "verification_uri"),
    intervalSeconds: typeof interval === "number" && interval > 0 ? interval : undefined,
    expiresInSeconds: expiresIn,
  };
}

/** Token response → AuthToken; a missing refresh_token keeps the stored one. */
function tokenFromResponse(
  json: Record<string, unknown>,
  previousRefreshToken: string | undefined,
  now: number,
): AuthToken {
  const access = json.access_token;
  // Rotation tolerance: xAI may omit refresh_token on refresh — the
  // previous one stays valid; anything else must be a string.
  const rawRefresh = json.refresh_token ?? previousRefreshToken;
  const expiresInSeconds =
    json.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : (json.expires_in as number);
  if (typeof access !== "string" || access.length === 0 || typeof rawRefresh !== "string") {
    throw new Error(`Invalid xAI token response: ${JSON.stringify(json)}`);
  }
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error("Invalid xAI OAuth response field: expires_in");
  }
  return {
    accessToken: access,
    refreshToken: rawRefresh,
    expiresAt: now + expiresInSeconds * 1000 - XAI_REFRESH_SKEW_MS,
    grant: { provider: "xai" },
    updatedAt: now,
  };
}

/** Thrown by {@link loginXai} when the user declines the ToS warning. */
export class XaiLoginAborted extends Error {
  constructor() {
    super("subscription auth aborted: terms of service not acknowledged");
    this.name = "XaiLoginAborted";
  }
}

/**
 * The full interactive xAI login: ToS acknowledgement, device-code
 * request, then the standard poll loop (authorization_pending /
 * slow_down / access_denied / expired_token).
 */
export async function loginXai(
  io: AuthorizationIo,
  opts: { overrides?: XaiAuthOverrides; fetchImpl?: XaiEndpointFetch; now?: number; clock?: DeviceFlowClock } = {},
): Promise<AuthToken> {
  if (!(await confirmToSWarningFor(io, "xai"))) throw new XaiLoginAborted();

  const config = resolveXaiOAuthConfig(opts.overrides);
  const fetchImpl = opts.fetchImpl ?? defaultXaiEndpointFetch;
  const device = await requestDeviceCode(config, fetchImpl);
  await io.info(
    `Open ${device.verificationUri} in a browser and enter code ${device.userCode} ` +
      `(expires in ${Math.floor(device.expiresInSeconds / 60)} minutes).`,
  );

  const options: DevicePollOptions<AuthToken> = {
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    waitBeforeFirstPoll: true,
    ...(opts.clock ? { clock: opts.clock } : {}),
    poll: async (): Promise<DevicePollResult<AuthToken>> => {
      const result = await fetchImpl(config.tokenUrl, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        device_code: device.deviceCode,
      });
      const json = result.json;
      if (result.status === 200) {
        try {
          return { status: "complete", value: tokenFromResponse(json, undefined, opts.now ?? Date.now()) };
        } catch (err) {
          return { status: "failed", message: err instanceof Error ? err.message : String(err) };
        }
      }
      const error = json.error;
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") {
        const interval = json.interval;
        return {
          status: "slow_down",
          intervalSeconds: typeof interval === "number" ? interval : undefined,
        };
      }
      if (error === "access_denied" || error === "authorization_denied") {
        return { status: "failed", message: "xAI device authorization was denied" };
      }
      if (error === "expired_token") return { status: "failed", message: "xAI device code expired" };
      return { status: "failed", message: `xAI token polling failed (HTTP ${result.status}): ${JSON.stringify(json)}` };
    },
  };
  return pollDeviceCodeFlow(options);
}

/**
 * Refresh grant before stream (wired into auth/resolve.ts). Standard
 * refresh_token grant; rotation tolerance: a missing refresh_token
 * keeps the stored one.
 */
export async function refreshXaiToken(
  token: AuthToken,
  opts: { overrides?: XaiAuthOverrides; fetchImpl?: XaiEndpointFetch; now?: number } = {},
): Promise<AuthToken> {
  if (!token.refreshToken) {
    throw new Error("xAI token has no refresh token; run `moh provider login`");
  }
  const config = resolveXaiOAuthConfig(opts.overrides);
  const fetchImpl = opts.fetchImpl ?? defaultXaiEndpointFetch;
  const now = opts.now ?? Date.now();
  const result = await fetchImpl(config.tokenUrl, {
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: token.refreshToken,
  });
  if (result.status !== 200) {
    throw new Error(`xAI token refresh failed (HTTP ${result.status}); run \`moh provider login\``);
  }
  const fresh = tokenFromResponse(result.json, token.refreshToken, now);
  return { ...fresh, account: fresh.account ?? token.account };
}
