/**
 * Kimi Code subscription grant (issue #162, ADR-0010). Primary source:
 * pi-ai `auth/oauth/kimi-coding.js` (MIT, 0.84.2): RFC 8628 device
 * authorization grant against https://auth.kimi.com with **JSON**
 * responses (both endpoints are form-encoded requests), host overridable
 * (pi: KIMI_CODE_OAUTH_HOST / KIMI_OAUTH_HOST). The access token
 * authenticates requests to https://api.kimi.com/coding as a Bearer
 * header — wire anthropic-messages (already dispatched by #159), with
 * the catalog's compat flags (allowEmptySignature, forceAdaptiveThinking)
 * riding per-model via #164.
 */
import type { AuthToken, KimiCodingAuthOverrides } from "./types";
import { confirmToSWarningFor, type AuthorizationIo } from "./oauth";
import { pollDeviceCodeFlow, type DeviceFlowClock, type DevicePollOptions, type DevicePollResult } from "./device-code";

export const KIMI_CODE_OAUTH_DEFAULTS = {
  oauthHost: "https://auth.kimi.com",
  clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
} as const;

/** The Kimi coding backend (anthropic-messages wire, #159 defaults). */
export const KIMI_CODE_API_BASE_URL = "https://api.kimi.com/coding";

export interface KimiCodingOAuthConfig {
  oauthHost: string;
  clientId: string;
}

/**
 * Defaults merged with user overrides (`auth.overrides.kimi-coding`).
 * The env vars mirror pi's escape hatches and win over both — drift in
 * the wild gets fixed without a config edit.
 */
export function resolveKimiCodingOAuthConfig(overrides?: KimiCodingAuthOverrides): KimiCodingOAuthConfig {
  const envHost = process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST;
  return {
    oauthHost: (envHost || overrides?.oauthHost || KIMI_CODE_OAUTH_DEFAULTS.oauthHost).replace(/\/+$/, ""),
    clientId: KIMI_CODE_OAUTH_DEFAULTS.clientId,
  };
}

/**
 * HTTP seam: form-encoded POST, JSON response — the shared shape of
 * both Kimi endpoints (device authorization + token).
 */
export type KimiCodingEndpointFetch = (
  url: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

export const defaultKimiCodingEndpointFetch: KimiCodingEndpointFetch = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body as Record<string, string>).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Only http(s) verification URIs are trusted (opened in a browser). */
function trustedHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href;
  } catch {
    return null;
  }
}

async function requestDeviceAuthorization(config: KimiCodingOAuthConfig, fetchImpl: KimiCodingEndpointFetch): Promise<DeviceCode> {
  const result = await fetchImpl(`${config.oauthHost}/api/oauth/device_authorization`, {
    client_id: config.clientId,
  });
  if (result.status !== 200) {
    throw new Error(`Kimi Code device authorization failed (HTTP ${result.status}): ${JSON.stringify(result.json)}`);
  }
  const json = result.json;
  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const verificationUri = trustedHttpUrl(json.verification_uri);
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    verificationUri === null
  ) {
    throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(json)}`);
  }
  const interval = json.interval;
  const expiresIn = json.expires_in;
  return {
    deviceCode,
    userCode,
    verificationUri,
    intervalSeconds:
      typeof interval === "number" && Number.isFinite(interval) && interval > 0
        ? interval
        : DEFAULT_POLL_INTERVAL_SECONDS,
    expiresInSeconds:
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn
        : DEVICE_CODE_TIMEOUT_SECONDS,
  };
}

/** Token response → AuthToken. Kimi always returns access + refresh + expires_in. */
function tokenFromResponse(json: Record<string, unknown>, now: number): AuthToken {
  const access = json.access_token;
  const refresh = json.refresh_token;
  const expiresIn = json.expires_in;
  if (
    typeof access !== "string" || !access ||
    typeof refresh !== "string" || !refresh ||
    typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0
  ) {
    throw new Error(`Kimi Code token response missing fields: ${JSON.stringify(json)}`);
  }
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: now + expiresIn * 1000,
    grant: { provider: "kimi-coding" },
    updatedAt: now,
  };
}

/** Thrown by {@link loginKimiCoding} when the user declines the ToS warning. */
export class KimiCodingLoginAborted extends Error {
  constructor() {
    super("subscription auth aborted: terms of service not acknowledged");
    this.name = "KimiCodingLoginAborted";
  }
}

/**
 * The full interactive Kimi Code login: ToS acknowledgement, device
 * authorization (JSON), then the standard poll loop against
 * /api/oauth/token. 5xx responses fail fast (pi's posture) instead of
 * burning the whole device-code lifetime.
 */
export async function loginKimiCoding(
  io: AuthorizationIo,
  opts: { overrides?: KimiCodingAuthOverrides; fetchImpl?: KimiCodingEndpointFetch; now?: number; clock?: DeviceFlowClock } = {},
): Promise<AuthToken> {
  if (!(await confirmToSWarningFor(io, "kimi-coding"))) throw new KimiCodingLoginAborted();

  const config = resolveKimiCodingOAuthConfig(opts.overrides);
  const fetchImpl = opts.fetchImpl ?? defaultKimiCodingEndpointFetch;
  const device = await requestDeviceAuthorization(config, fetchImpl);
  await io.info(
    `Open ${device.verificationUri} in a browser and enter code ${device.userCode} ` +
      `(expires in ${Math.floor(device.expiresInSeconds / 60)} minutes).`,
  );

  const options: DevicePollOptions<AuthToken> = {
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    waitBeforeFirstPoll: true,
    clock: opts.clock,
    poll: async (): Promise<DevicePollResult<AuthToken>> => {
      const result = await fetchImpl(`${config.oauthHost}/api/oauth/token`, {
        client_id: config.clientId,
        device_code: device.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      const json = result.json;
      if (result.status >= 500) {
        return { status: "failed", message: `Kimi Code device token request failed (HTTP ${result.status}): ${JSON.stringify(json)}` };
      }
      if (result.status === 200) {
        try {
          return { status: "complete", value: tokenFromResponse(json, opts.now ?? Date.now()) };
        } catch (err) {
          return { status: "failed", message: err instanceof Error ? err.message : String(err) };
        }
      }
      const error = json.error;
      const description = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") {
        const interval = json.interval;
        return { status: "slow_down", intervalSeconds: typeof interval === "number" && interval > 0 ? interval : undefined };
      }
      if (error === "expired_token") {
        return { status: "failed", message: "Kimi Code device authorization expired. Please restart login." };
      }
      if (error === "access_denied") return { status: "failed", message: "Kimi Code login was denied." };
      return {
        status: "failed",
        message: `Kimi Code device token request failed (HTTP ${result.status})${typeof error === "string" ? `: ${error}${description}` : ""}`,
      };
    },
  };
  return pollDeviceCodeFlow(options);
}

/**
 * Refresh grant before stream (wired into auth/resolve.ts): standard
 * refresh_token grant against the same host. Kimi always returns a new
 * refresh token with the pair.
 */
export async function refreshKimiCodingToken(
  token: AuthToken,
  opts: { overrides?: KimiCodingAuthOverrides; fetchImpl?: KimiCodingEndpointFetch; now?: number } = {},
): Promise<AuthToken> {
  if (!token.refreshToken) {
    throw new Error("Kimi Code token has no refresh token; run `moh provider login`");
  }
  const config = resolveKimiCodingOAuthConfig(opts.overrides);
  const fetchImpl = opts.fetchImpl ?? defaultKimiCodingEndpointFetch;
  const now = opts.now ?? Date.now();
  const result = await fetchImpl(`${config.oauthHost}/api/oauth/token`, {
    client_id: config.clientId,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
  });
  // Unauthorized / invalid_grant: the stored credential is dead — the
  // recovery path is re-login, not retry.
  if (result.status === 401 || result.status === 403 || result.json.error === "invalid_grant") {
    throw new Error(`Kimi Code token refresh unauthorized (HTTP ${result.status}); run \`moh provider login\``);
  }
  if (result.status !== 200) {
    throw new Error(`Kimi Code token refresh failed (HTTP ${result.status}); run \`moh provider login\``);
  }
  const fresh = tokenFromResponse(result.json, now);
  return { ...fresh, account: fresh.account ?? token.account };
}
