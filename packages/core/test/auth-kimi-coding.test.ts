import { describe, expect, test } from "bun:test";
import {
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_OAUTH_DEFAULTS,
  KimiCodingLoginAborted,
  loginKimiCoding,
  refreshKimiCodingToken,
  resolveKimiCodingOAuthConfig,
  type KimiCodingEndpointFetch,
} from "../src/auth/kimi-coding";
import { isSubscriptionKind } from "../src/auth/lifecycle";
import { resolveEndpointCredential } from "../src/auth/resolve";
import { saveTokens } from "../src/auth/store";
import { Endpoint } from "../src/route";
import type { AuthorizationIo } from "../src/auth/oauth";
import type { DeviceFlowClock } from "../src/auth/device-code";
import type { AuthToken } from "../src/auth/types";

const NOW = 1_700_000_000_000;
const fastClock: DeviceFlowClock = { now: () => NOW, sleep: async () => {} };
const IO: AuthorizationIo = { ask: async () => "y", info: async () => {} };

function scriptedEndpoint(
  results: Array<{ status: number; json: Record<string, unknown> }>,
): KimiCodingEndpointFetch & { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fn: KimiCodingEndpointFetch = async (url, body) => {
    calls.push({ url, body });
    return results[i++] ?? { status: 500, json: {} };
  };
  return Object.assign(fn, { calls });
}

const DEVICE = {
  status: 200,
  json: {
    device_code: "dc-1",
    user_code: "KIMI-CODE",
    verification_uri: "https://auth.kimi.com/device",
    verification_uri_complete: "https://auth.kimi.com/device?code=KIMI-CODE",
    interval: 5,
    expires_in: 900,
  },
};

describe("kimi-coding config", () => {
  test("captured defaults (drift watch)", () => {
    expect(KIMI_CODE_OAUTH_DEFAULTS.oauthHost).toBe("https://auth.kimi.com");
    expect(KIMI_CODE_OAUTH_DEFAULTS.clientId).toBe("17e5f671-d194-4dfb-9706-5516cb48c098");
    expect(KIMI_CODE_API_BASE_URL).toBe("https://api.kimi.com/coding");
  });

  test("env host wins; then overrides; trailing slashes trimmed", () => {
    process.env.KIMI_CODE_OAUTH_HOST = "https://mirror.example//";
    expect(resolveKimiCodingOAuthConfig().oauthHost).toBe("https://mirror.example");
    delete process.env.KIMI_CODE_OAUTH_HOST;
    process.env.KIMI_OAUTH_HOST = "https://env2.example";
    expect(resolveKimiCodingOAuthConfig({ oauthHost: "https://override.example" }).oauthHost).toBe("https://env2.example");
    delete process.env.KIMI_OAUTH_HOST;
    expect(resolveKimiCodingOAuthConfig({ oauthHost: "https://override.example/" }).oauthHost).toBe("https://override.example");
  });
});

describe("loginKimiCoding", () => {
  test("declining the ToS aborts before any network I/O", async () => {
    const io: AuthorizationIo = { ask: async () => "n", info: async () => {} };
    await expect(loginKimiCoding(io, { clock: fastClock })).rejects.toBeInstanceOf(KimiCodingLoginAborted);
  });

  test("device flow completes: pending then token with expiry", async () => {
    const fetchImpl = scriptedEndpoint([
      DEVICE,
      { status: 400, json: { error: "authorization_pending" } },
      { status: 200, json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } },
    ]);
    const token = await loginKimiCoding(IO, { fetchImpl, now: NOW, clock: fastClock });
    expect(token.accessToken).toBe("at-1");
    expect(token.refreshToken).toBe("rt-1");
    expect(token.expiresAt).toBe(NOW + 3600_000);
    expect(token.grant).toEqual({ provider: "kimi-coding" });
    expect(fetchImpl.calls[0]!.url).toBe("https://auth.kimi.com/api/oauth/device_authorization");
    expect(fetchImpl.calls[2]!.url).toBe("https://auth.kimi.com/api/oauth/token");
    expect(fetchImpl.calls[2]!.body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });

  test("untrusted verification_uri is rejected", async () => {
    const fetchImpl = scriptedEndpoint([
      { status: 200, json: { ...DEVICE.json, verification_uri: "javascript:alert(1)" } },
    ]);
    await expect(loginKimiCoding(IO, { fetchImpl, now: NOW, clock: fastClock })).rejects.toThrow("Invalid Kimi Code device authorization response");
  });

  test("5xx fails fast instead of burning the device-code lifetime", async () => {
    const fetchImpl = scriptedEndpoint([DEVICE, { status: 503, json: {} }]);
    await expect(loginKimiCoding(IO, { fetchImpl, now: NOW, clock: fastClock })).rejects.toThrow("HTTP 503");
  });

  test("expired_token and access_denied fail with their messages", async () => {
    const a = scriptedEndpoint([DEVICE, { status: 400, json: { error: "expired_token" } }]);
    await expect(loginKimiCoding(IO, { fetchImpl: a, now: NOW, clock: fastClock })).rejects.toThrow("expired. Please restart login");
    const b = scriptedEndpoint([DEVICE, { status: 400, json: { error: "access_denied" } }]);
    await expect(loginKimiCoding(IO, { fetchImpl: b, now: NOW, clock: fastClock })).rejects.toThrow("denied");
  });
});

describe("refreshKimiCodingToken", () => {
  const stored: AuthToken = {
    accessToken: "old",
    refreshToken: "rt-old",
    expiresAt: NOW - 1,
    grant: { provider: "kimi-coding" },
    updatedAt: NOW,
  };

  test("refresh grant against the same host; new pair stored", async () => {
    const fetchImpl = scriptedEndpoint([
      { status: 200, json: { access_token: "new", refresh_token: "rt-new", expires_in: 3600 } },
    ]);
    const fresh = await refreshKimiCodingToken(stored, { fetchImpl, now: NOW });
    expect(fresh.accessToken).toBe("new");
    expect(fresh.refreshToken).toBe("rt-new");
    expect(fetchImpl.calls[0]!.body.grant_type).toBe("refresh_token");
  });

  test("401/403/invalid_grant throw with the re-login hint", async () => {
    await expect(refreshKimiCodingToken({ ...stored, refreshToken: undefined })).rejects.toThrow("no refresh token");
    const a = scriptedEndpoint([{ status: 401, json: { error: "invalid_grant" } }]);
    await expect(refreshKimiCodingToken(stored, { fetchImpl: a, now: NOW })).rejects.toThrow("moh provider login");
  });
});

describe("resolve integration", () => {
  test("kimi-coding is a subscription kind; far-future token resolves without refresh", async () => {
    expect(isSubscriptionKind("kimi-coding")).toBe(true);
    const authFile = `/tmp/moh-test-kimi-${process.pid}.json`;
    await Bun.write(authFile, "{}");
    const endpoint = new Endpoint({
      name: "kimi",
      kind: "kimi-coding",
      auth: { kind: "subscription" },
    });
    saveTokens(authFile, "kimi", {
      accessToken: "live",
      refreshToken: "rt",
      expiresAt: NOW + 3600_000,
      grant: { provider: "kimi-coding" },
      updatedAt: NOW,
    });
    const resolved = await resolveEndpointCredential({ endpoint, modelId: "k3" }, { configFile: authFile, now: NOW });
    expect(resolved).toBe("live");
  });
});
