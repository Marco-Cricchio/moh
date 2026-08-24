import { describe, expect, test } from "bun:test";
import {
  XAI_API_BASE_URL,
  XAI_OAUTH_DEFAULTS,
  XAI_SCOPES,
  XaiLoginAborted,
  loginXai,
  refreshXaiToken,
  resolveXaiOAuthConfig,
  type XaiEndpointFetch,
} from "../src/auth/xai";
import { pollDeviceCodeFlow, type DeviceFlowClock } from "../src/auth/device-code";
import { isSubscriptionKind } from "../src/auth/lifecycle";
import { resolveEndpointCredential } from "../src/auth/resolve";
import { saveTokens } from "../src/auth/store";
import { Endpoint } from "../src/route";
import type { AuthorizationIo } from "../src/auth/oauth";
import type { AuthToken } from "../src/auth/types";

const NOW = 1_700_000_000_000;

function scriptedEndpoint(
  results: Array<{ status: number; json: Record<string, unknown> }>,
): XaiEndpointFetch & { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fn: XaiEndpointFetch = async (url, body) => {
    calls.push({ url, body });
    return results[i++] ?? { status: 500, json: {} };
  };
  return Object.assign(fn, { calls });
}

/** Instant clock: no sleeps, monotonic-ish now. */
const fastClock: DeviceFlowClock = { now: () => NOW, sleep: async () => {} };

const IO: AuthorizationIo = { ask: async () => "y", info: async () => {} };

const DEVICE = {
  status: 200,
  json: {
    device_code: "dc-1",
    user_code: "ABCD-EFGH",
    verification_uri: "https://auth.x.ai/device",
    interval: 5,
    expires_in: 900,
  },
};

describe("xai config", () => {
  test("captured defaults (drift watch)", () => {
    expect(XAI_OAUTH_DEFAULTS.deviceCodeUrl).toBe("https://auth.x.ai/oauth2/device/code");
    expect(XAI_OAUTH_DEFAULTS.tokenUrl).toBe("https://auth.x.ai/oauth2/token");
    expect(XAI_OAUTH_DEFAULTS.clientId).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(XAI_API_BASE_URL).toBe("https://api.x.ai/v1");
    expect(XAI_SCOPES).toContain("offline_access");
  });

  test("overrides win; absent fields keep defaults", () => {
    const config = resolveXaiOAuthConfig({ clientId: "custom" });
    expect(config.clientId).toBe("custom");
    expect(config.tokenUrl).toBe(XAI_OAUTH_DEFAULTS.tokenUrl);
  });
});

describe("device-code poller", () => {
  test("polls pending then completes; sleeps between polls", async () => {
    let n = 0;
    const slept: number[] = [];
    const clock: DeviceFlowClock = { now: () => NOW, sleep: async (ms) => { slept.push(ms); } };
    const value = await pollDeviceCodeFlow({
      intervalSeconds: 5,
      expiresInSeconds: 60,
      waitBeforeFirstPoll: true,
      clock,
      poll: async () => (n++ === 0 ? { status: "pending" } : { status: "complete", value: 42 }),
    });
    expect(value).toBe(42);
    expect(slept.length).toBe(2); // first wait + between-polls wait
    expect(slept.every((ms) => ms >= 1000)).toBe(true);
  });

  test("slow_down applies the RFC 3.5 +5s increment", async () => {
    let n = 0;
    const slept: number[] = [];
    const clock: DeviceFlowClock = { now: () => NOW, sleep: async (ms) => { slept.push(ms); } };
    await pollDeviceCodeFlow({
      intervalSeconds: 5,
      expiresInSeconds: 60,
      clock,
      poll: async () => (n++ === 0 ? { status: "slow_down" } : { status: "complete", value: 1 }),
    });
    expect(slept).toEqual([10_000]); // no first-poll wait; after slow_down the interval is 5s+5s
  });

  test("failed and timeout paths throw", async () => {
    await expect(
      pollDeviceCodeFlow({ clock: fastClock, poll: async () => ({ status: "failed", message: "denied" }) }),
    ).rejects.toThrow("denied");
    // The timeout case: now() frozen before deadline would loop forever —
    // use a clock that advances past the deadline.
    let t = NOW;
    const clock: DeviceFlowClock = { now: () => t, sleep: async () => { t += 2000; } };
    await expect(
      pollDeviceCodeFlow({ clock, expiresInSeconds: 1, poll: async () => ({ status: "pending" }) }),
    ).rejects.toThrow("timed out");
  });
});

describe("loginXai", () => {
  test("declining the ToS aborts before any network I/O", async () => {
    const io: AuthorizationIo = { ask: async () => "n", info: async () => {} };
    await expect(loginXai(io, { clock: fastClock })).rejects.toBeInstanceOf(XaiLoginAborted);
  });

  test("device flow completes: pending then token, expiry skewed 5 minutes early", async () => {
    const fetchImpl = scriptedEndpoint([
      DEVICE,
      { status: 400, json: { error: "authorization_pending" } },
      { status: 200, json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } },
    ]);
    const token = await loginXai(IO, { fetchImpl, now: NOW, clock: fastClock });
    expect(token.accessToken).toBe("at-1");
    expect(token.refreshToken).toBe("rt-1");
    expect(token.expiresAt).toBe(NOW + 3600_000 - 5 * 60_000);
    expect(token.grant).toEqual({ provider: "xai" });
    expect(fetchImpl.calls[0]!.body.scope).toBe(XAI_SCOPES);
    expect(fetchImpl.calls[2]!.body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });

  test("untrusted (non-https) verification_uri is rejected", async () => {
    const fetchImpl = scriptedEndpoint([
      { status: 200, json: { ...DEVICE.json, verification_uri: "file:///etc/passwd" } },
    ]);
    await expect(loginXai(IO, { fetchImpl, now: NOW, clock: fastClock })).rejects.toThrow("Untrusted verification URI");
  });

  test("access_denied fails the flow", async () => {
    const fetchImpl = scriptedEndpoint([DEVICE, { status: 400, json: { error: "access_denied" } }]);
    await expect(loginXai(IO, { fetchImpl, now: NOW, clock: fastClock })).rejects.toThrow("denied");
  });
});

describe("refreshXaiToken", () => {
  const stored: AuthToken = {
    accessToken: "old",
    refreshToken: "rt-old",
    expiresAt: NOW - 1,
    grant: { provider: "xai" },
    updatedAt: NOW,
  };

  test("refresh grant; rotation tolerance keeps the old refresh token when omitted", async () => {
    const fetchImpl = scriptedEndpoint([
      { status: 200, json: { access_token: "new", expires_in: 3600 } }, // no refresh_token
    ]);
    const fresh = await refreshXaiToken(stored, { fetchImpl, now: NOW });
    expect(fresh.accessToken).toBe("new");
    expect(fresh.refreshToken).toBe("rt-old"); // kept
    expect(fetchImpl.calls[0]!.body.grant_type).toBe("refresh_token");
  });

  test("missing stored refresh token and failed refresh throw with re-login hint", async () => {
    await expect(refreshXaiToken({ ...stored, refreshToken: undefined })).rejects.toThrow("no refresh token");
    const fetchImpl = scriptedEndpoint([{ status: 401, json: { error: "invalid_grant" } }]);
    await expect(refreshXaiToken(stored, { fetchImpl, now: NOW })).rejects.toThrow("moh provider login");
  });
});

describe("resolve integration", () => {
  test("xai is a subscription kind; far-future token resolves without refresh", async () => {
    expect(isSubscriptionKind("xai")).toBe(true);
    const authFile = `/tmp/moh-test-xai-${process.pid}.json`;
    await Bun.write(authFile, "{}");
    const endpoint = new Endpoint({
      name: "grok",
      kind: "xai",
      auth: { kind: "subscription" },
    });
    // Far-future expiry: outside the refresh window, so no network I/O.
    saveTokens(authFile, "grok", {
      accessToken: "live",
      refreshToken: "rt-x",
      expiresAt: NOW + 3600_000,
      grant: { provider: "xai" },
      updatedAt: NOW,
    });
    const resolved = await resolveEndpointCredential({ endpoint, modelId: "grok-4.6" }, { configFile: authFile, now: NOW });
    expect(resolved).toBe("live"); // plain credential — no ChatGPT-style context
  });
});
