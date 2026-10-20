import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exchangeAnthropicCode, refreshAnthropicToken } from "../src/auth/anthropic";
import { exchangeGoogleCode, refreshGoogleToken } from "../src/auth/google";
import {
  exchangeOpenaiApiKey,
  exchangeOpenaiCode,
  pollOpenaiDeviceToken,
  refreshOpenaiToken,
  requestOpenaiUserCode,
} from "../src/auth/openai";
import { exchangeOpenrouterCode } from "../src/auth/openrouter";
import { loginXai, refreshXaiToken } from "../src/auth/xai";
import { loginKimiCoding, refreshKimiCodingToken } from "../src/auth/kimi-coding";
import type { DeviceFlowClock } from "../src/auth/device-code";
import type { AuthorizationIo } from "../src/auth/oauth";
import type { AuthToken } from "../src/auth/types";

/**
 * Characterization of the DEFAULT fetch of the six OAuth grants that share
 * `{status, json}` seams (#1428): what actually goes over the wire — method,
 * path, raw header order/case, raw body — and how a non-JSON reply is
 * absorbed. Reached through the public functions without `fetchImpl`, aimed
 * at a local HTTP server; no real network. GitHub Copilot is excluded (its
 * default is not touched and its URLs are always https://${domain}/…).
 */

interface Seen {
  method: string;
  path: string;
  headers: string[];
  body: string;
}

/** Headers the runtime adds on its own, identical before and after. */
const RUNTIME_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "accept-language", "user-agent"]);

let server: Server;
let base: string;
let seen: Seen[];
let respond: (path: string) => { status: number; body: string };

const JSON_ERR = { status: 400, body: JSON.stringify({ error: "access_denied" }) };

beforeEach(async () => {
  seen = [];
  respond = () => JSON_ERR;
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        if (RUNTIME_HEADERS.has(name.toLowerCase())) continue;
        headers.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      const url = new URL(req.url ?? "/", "http://x");
      seen.push({ method: req.method ?? "", path: url.pathname, headers, body: Buffer.concat(chunks).toString("utf8") });
      const out = respond(url.pathname);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const swallow = async (run: () => Promise<unknown>): Promise<void> => {
  await run().catch(() => undefined);
};

const TOKEN: AuthToken = { accessToken: "at", refreshToken: "rt" } as AuthToken;
const IO: AuthorizationIo = { ask: async () => "y", info: async () => {} };
const fastClock: DeviceFlowClock = { now: () => 1_700_000_000_000, sleep: async () => {} };

const XAI_DEVICE = {
  status: 200,
  body: JSON.stringify({ device_code: "dc", user_code: "UC", verification_uri: "https://auth.x.ai/device", expires_in: 900 }),
};
const KIMI_DEVICE = {
  status: 200,
  body: JSON.stringify({ device_code: "dc", user_code: "UC", verification_uri: "https://kimi.example/device", expires_in: 900 }),
};

describe("default fetch wire shape", () => {
  test("anthropic: JSON, content-type only (code exchange with long-lived retry, refresh)", async () => {
    const config = { authorizeUrl: `${base}/a`, tokenUrl: `${base}/anthropic/token`, clientId: "cid", manualRedirectUrl: `${base}/m`, inferenceExpiresIn: 31536000 };
    await swallow(() => exchangeAnthropicCode(config, { code: "c", codeVerifier: "v", state: "s", redirectUri: "http://r", inferenceOnly: true }));
    await swallow(() => refreshAnthropicToken(config, TOKEN));
    expect(seen).toMatchSnapshot();
  });

  test("google: form, content-type only (code exchange, refresh)", async () => {
    const config = { authorizeUrl: `${base}/a`, tokenUrl: `${base}/google/token`, clientId: "cid", clientSecret: "sec", manualRedirectUrl: `${base}/m` };
    await swallow(() => exchangeGoogleCode(config, { code: "c", redirectUri: "http://r", codeVerifier: "v" }));
    await swallow(() => refreshGoogleToken(config, TOKEN));
    expect(seen).toMatchSnapshot();
  });

  test("openai: JSON, content-type only (code exchange, api-key mint, refresh, device user code, device poll)", async () => {
    const config = { issuer: `${base}/openai`, clientId: "cid", ports: [1455], callbackPath: "/auth/callback" };
    await swallow(() => exchangeOpenaiCode(config, { code: "c", codeVerifier: "v", redirectUri: "http://r" }));
    await swallow(() => exchangeOpenaiApiKey(config, { id_token: "idt" }));
    await swallow(() => refreshOpenaiToken(config, TOKEN));
    await swallow(() => requestOpenaiUserCode(config, { codeChallenge: "ch" }));
    await swallow(() => pollOpenaiDeviceToken(config, { deviceAuthId: "da", userCode: "uc" }, { timeoutMs: 1, pollIntervalMs: 1, now: (() => { let n = 0; return () => (n++ < 2 ? 0 : 10); })(), sleep: async () => {} }));
    expect(seen).toMatchSnapshot();
  });

  test("openrouter: JSON, accept + content-type (key exchange)", async () => {
    const config = { authorizeUrl: `${base}/a`, tokenUrl: `${base}/openrouter/key` };
    await swallow(() => exchangeOpenrouterCode(config, { code: "c", codeVerifier: "v" }));
    expect(seen).toMatchSnapshot();
  });

  test("xai: form, accept + content-type (device code, poll, refresh)", async () => {
    const overrides = { deviceCodeUrl: `${base}/xai/device`, tokenUrl: `${base}/xai/token` };
    respond = (path) => (path === "/xai/device" ? XAI_DEVICE : JSON_ERR);
    await swallow(() => loginXai(IO, { overrides, clock: fastClock }));
    await swallow(() => refreshXaiToken(TOKEN, { overrides }));
    expect(seen).toMatchSnapshot();
  });

  test("kimi-coding: form, content-type + accept (device authorization, poll, refresh)", async () => {
    const saved = [process.env.KIMI_CODE_OAUTH_HOST, process.env.KIMI_OAUTH_HOST];
    delete process.env.KIMI_CODE_OAUTH_HOST;
    delete process.env.KIMI_OAUTH_HOST;
    try {
      const overrides = { oauthHost: `${base}/kimi` };
      respond = (path) => (path === "/kimi/api/oauth/device_authorization" ? KIMI_DEVICE : JSON_ERR);
      await swallow(() => loginKimiCoding(IO, { overrides, clock: fastClock }));
      await swallow(() => refreshKimiCodingToken(TOKEN, { overrides }));
    } finally {
      if (saved[0] !== undefined) process.env.KIMI_CODE_OAUTH_HOST = saved[0];
      if (saved[1] !== undefined) process.env.KIMI_OAUTH_HOST = saved[1];
    }
    expect(seen).toMatchSnapshot();
  });
});

describe("default fetch response handling", () => {
  test("a non-JSON reply is absorbed as an empty object, never thrown raw", async () => {
    respond = () => ({ status: 200, body: "not json" });
    const failures: string[] = [];
    const record = async (run: () => Promise<unknown>) => {
      await run().then(
        () => failures.push("resolved"),
        (e: unknown) => failures.push(e instanceof Error ? e.message : String(e)),
      );
    };
    await record(() => refreshAnthropicToken({ authorizeUrl: "", tokenUrl: `${base}/t`, clientId: "c", manualRedirectUrl: "", inferenceExpiresIn: 1 }, TOKEN));
    await record(() => refreshGoogleToken({ authorizeUrl: "", tokenUrl: `${base}/t`, clientId: "c", clientSecret: "s", manualRedirectUrl: "" }, TOKEN));
    await record(() => refreshOpenaiToken({ issuer: base, clientId: "c", ports: [1], callbackPath: "/" }, TOKEN));
    await record(() => exchangeOpenrouterCode({ authorizeUrl: "", tokenUrl: `${base}/t` }, { code: "c", codeVerifier: "v" }));
    await record(() => refreshXaiToken(TOKEN, { overrides: { tokenUrl: `${base}/t` } }));
    await record(() => refreshKimiCodingToken(TOKEN, { overrides: { oauthHost: base } }));
    expect(failures).toMatchSnapshot();
  });
});

describe("default fetch timeout", () => {
  test("AbortSignal.timeout(30000) only for openrouter and kimi-coding", async () => {
    const spy = spyOn(AbortSignal, "timeout");
    try {
      const calls = async (run: () => Promise<unknown>): Promise<unknown[]> => {
        spy.mockClear();
        await swallow(run);
        return spy.mock.calls.map((c) => c[0]);
      };
      const kimiEnv = [process.env.KIMI_CODE_OAUTH_HOST, process.env.KIMI_OAUTH_HOST];
      delete process.env.KIMI_CODE_OAUTH_HOST;
      delete process.env.KIMI_OAUTH_HOST;
      const observed = {
        anthropic: await calls(() => refreshAnthropicToken({ authorizeUrl: "", tokenUrl: `${base}/t`, clientId: "c", manualRedirectUrl: "", inferenceExpiresIn: 1 }, TOKEN)),
        openai: await calls(() => refreshOpenaiToken({ issuer: base, clientId: "c", ports: [1], callbackPath: "/" }, TOKEN)),
        google: await calls(() => refreshGoogleToken({ authorizeUrl: "", tokenUrl: `${base}/t`, clientId: "c", clientSecret: "s", manualRedirectUrl: "" }, TOKEN)),
        xai: await calls(() => refreshXaiToken(TOKEN, { overrides: { tokenUrl: `${base}/t` } })),
        openrouter: await calls(() => exchangeOpenrouterCode({ authorizeUrl: "", tokenUrl: `${base}/t` }, { code: "c", codeVerifier: "v" })),
        "kimi-coding": await calls(() => refreshKimiCodingToken(TOKEN, { overrides: { oauthHost: base } })),
      };
      if (kimiEnv[0] !== undefined) process.env.KIMI_CODE_OAUTH_HOST = kimiEnv[0];
      if (kimiEnv[1] !== undefined) process.env.KIMI_OAUTH_HOST = kimiEnv[1];
      expect(observed).toEqual({
        anthropic: [],
        openai: [],
        google: [],
        xai: [],
        openrouter: [30_000],
        "kimi-coding": [30_000],
      });
    } finally {
      spy.mockRestore();
    }
  });
});
