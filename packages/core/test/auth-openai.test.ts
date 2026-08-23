import { describe, expect, test } from "bun:test";
import {
  CHATGPT_CODEX_BASE_URL,
  OPENAI_OAUTH_DEFAULTS,
  OPENAI_SCOPES,
  OpenAiLoginAborted,
  buildOpenaiAuthorizeUrl,
  exchangeOpenaiApiKey,
  exchangeOpenaiCode,
  loginOpenAI,
  pollOpenaiDeviceToken,
  refreshOpenaiToken,
  requestOpenaiUserCode,
  resolveOpenAiOAuthConfig,
  type OpenAiEndpointFetch,
} from "../src/auth/openai";
import { authSectionSchema } from "../src/auth/types";
import type { AuthorizationIo } from "../src/auth/oauth";
import type { AuthToken } from "../src/auth/types";

const CONFIG = resolveOpenAiOAuthConfig();
const NOW = 1_700_000_000_000;

/** Scripts every OpenAI auth endpoint: per-call results in order. */
function endpoint(
  results: Array<{ status: number; json: Record<string, unknown> }>,
): OpenAiEndpointFetch & { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fn: OpenAiEndpointFetch = async (url, body) => {
    calls.push({ url, body });
    return results[i++] ?? { status: 500, json: {} };
  };
  return Object.assign(fn, { calls });
}

/** Minimal JWT with namespaced id_token claims (token_data.rs IdClaims). */
function makeIdToken(claims: Record<string, unknown> = {}): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({
    "https://api.openai.com/profile": { email: "me@example.com" },
    "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-1" },
    ...claims,
  })}.${b64({ sig: true })}`;
}

const ID_TOKEN = makeIdToken();
const TOKEN_RESPONSE = {
  access_token: "oauth-at-1",
  refresh_token: "rt-1",
  id_token: ID_TOKEN,
};
const MINT_RESPONSE = { access_token: "sk-minted-1" };

describe("openai config + overrides", () => {
  test("captured defaults match the codex source (drift watch)", () => {
    expect(OPENAI_OAUTH_DEFAULTS.issuer).toBe("https://auth.openai.com");
    expect(OPENAI_OAUTH_DEFAULTS.clientId).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(OPENAI_OAUTH_DEFAULTS.ports).toEqual([1455, 1457]);
    expect(OPENAI_OAUTH_DEFAULTS.callbackPath).toBe("/auth/callback");
    expect(CHATGPT_CODEX_BASE_URL).toBe("https://chatgpt.com/backend-api/codex");
  });

  test("overrides win over defaults; absent fields keep defaults", () => {
    const config = resolveOpenAiOAuthConfig({ issuer: "https://auth.example" });
    expect(config.issuer).toBe("https://auth.example");
    expect(config.clientId).toBe(OPENAI_OAUTH_DEFAULTS.clientId);
  });

  test("overrides schema validates the auth section shape", () => {
    const section = authSectionSchema.parse({ tokens: {}, overrides: { openai: { clientId: "custom" } } });
    expect(section.overrides?.openai?.clientId).toBe("custom");
  });
});

describe("buildOpenaiAuthorizeUrl", () => {
  test("Codex shape: scopes, PKCE S256, originator + simplified-flow extras", () => {
    const url = new URL(
      buildOpenaiAuthorizeUrl(CONFIG, {
        codeChallenge: "challenge-1",
        state: "state-1",
        redirectUri: "http://localhost:1455/auth/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("scope")).toBe(OPENAI_SCOPES.join(" "));
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
  });
});

describe("exchangeOpenaiCode", () => {
  test("code exchange then RFC 8693 mint; minted key rides the api-key shape", async () => {
    const fetchImpl = endpoint([
      { status: 200, json: TOKEN_RESPONSE },
      { status: 200, json: MINT_RESPONSE },
    ]);
    const { token, minted } = await exchangeOpenaiCode(CONFIG, {
      code: "auth-code",
      codeVerifier: "verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      fetchImpl,
      now: NOW,
    });
    expect(fetchImpl.calls[0]).toMatchObject({
      url: "https://auth.openai.com/oauth/token",
      body: {
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: "http://localhost:1455/auth/callback",
        client_id: CONFIG.clientId,
        code_verifier: "verifier",
        scope: OPENAI_SCOPES.join(" "),
      },
    });
    expect(fetchImpl.calls[1]).toMatchObject({
      url: "https://auth.openai.com/oauth/token",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        requested_token: "openai-api-key",
        subject_token: ID_TOKEN,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        client_id: CONFIG.clientId,
      },
    });
    expect(token.access_token).toBe("oauth-at-1");
    // Posture (c): the minted key is the stored accessToken; OAuth set + plan live in grant.
    expect(minted).toEqual({
      accessToken: "sk-minted-1",
      refreshToken: "rt-1",
      grant: { provider: "openai", minted: true, oauthAccessToken: "oauth-at-1", idToken: ID_TOKEN, plan: "plus" },
      account: { email: "me@example.com" },
      updatedAt: NOW,
    });
  });

  test("non-200 code exchange throws", async () => {
    const fetchImpl = endpoint([{ status: 401, json: { error: "invalid_grant" } }]);
    await expect(
      exchangeOpenaiCode(CONFIG, { code: "c", codeVerifier: "v", redirectUri: "r", fetchImpl, now: NOW }),
    ).rejects.toThrow(/token exchange failed \(401\)/);
  });

  test("response without id_token fails the mint with a re-login hint", async () => {
    const fetchImpl = endpoint([
      { status: 200, json: { access_token: "at", refresh_token: "rt" } },
    ]);
    await expect(
      exchangeOpenaiCode(CONFIG, { code: "c", codeVerifier: "v", redirectUri: "r", fetchImpl, now: NOW }),
    ).rejects.toThrow(/id_token.*moh provider login/);
  });
});

describe("exchangeOpenaiApiKey", () => {
  test("non-200 mint throws", async () => {
    const fetchImpl = endpoint([{ status: 400, json: { error: "token_exchange_failed" } }]);
    await expect(exchangeOpenaiApiKey(CONFIG, { id_token: ID_TOKEN }, { fetchImpl })).rejects.toThrow(
      /API-key mint failed \(400\)/,
    );
  });
});

describe("refreshOpenaiToken", () => {
  const stored: AuthToken = {
    accessToken: "sk-minted-1",
    refreshToken: "rt-old",
    grant: { provider: "openai", minted: true, oauthAccessToken: "at-old", idToken: ID_TOKEN, plan: "plus" },
    account: { email: "me@example.com" },
    updatedAt: NOW - 10_000,
  };

  test("refresh grant then re-mint; rotated refresh token wins", async () => {
    const fetchImpl = endpoint([
      { status: 200, json: { ...TOKEN_RESPONSE, access_token: "at-new", refresh_token: "rt-rotated", id_token: makeIdToken({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }) } },
      { status: 200, json: { access_token: "sk-minted-2" } },
    ]);
    const fresh = await refreshOpenaiToken(CONFIG, stored, { fetchImpl, now: NOW });
    expect(fetchImpl.calls[0]).toMatchObject({
      body: {
        grant_type: "refresh_token",
        refresh_token: "rt-old",
        client_id: CONFIG.clientId,
        scope: OPENAI_SCOPES.join(" "),
      },
    });
    expect(fresh.accessToken).toBe("sk-minted-2");
    expect(fresh.refreshToken).toBe("rt-rotated");
    expect(fresh.grant).toMatchObject({ minted: true, plan: "pro" });
  });

  test("missing refresh_token in the response keeps the old one", async () => {
    const fetchImpl = endpoint([
      { status: 200, json: { access_token: "at-new" } },
      { status: 200, json: { access_token: "sk-minted-2" } },
    ]);
    const fresh = await refreshOpenaiToken(CONFIG, stored, { fetchImpl, now: NOW });
    expect(fresh.refreshToken).toBe("rt-old");
    // id_token carried over from grant metadata for the re-mint
    expect(fetchImpl.calls[1]!.body.subject_token).toBe(ID_TOKEN);
  });

  test("no stored refresh token is a re-login error", async () => {
    await expect(
      refreshOpenaiToken(CONFIG, { ...stored, refreshToken: undefined }, { now: NOW }),
    ).rejects.toThrow(/no refresh token.*moh provider login/);
  });

  test("refresh failure carries the re-login hint", async () => {
    const fetchImpl = endpoint([{ status: 400, json: { error: "invalid_grant" } }]);
    await expect(refreshOpenaiToken(CONFIG, stored, { fetchImpl, now: NOW })).rejects.toThrow(
      /refresh failed \(400\).*moh provider login/,
    );
  });
});

describe("device-code flow (custom protocol, not RFC 8628)", () => {
  test("usercode request carries client_id + PKCE challenge", async () => {
    const fetchImpl = endpoint([
      { status: 200, json: { user_code: "WDJB-MJHT", device_auth_id: "da-1", verification_uri: "https://auth.openai.com/device" } },
    ]);
    const device = await requestOpenaiUserCode(CONFIG, { codeChallenge: "challenge-1", fetchImpl });
    expect(fetchImpl.calls[0]).toMatchObject({
      url: "https://auth.openai.com/deviceauth/usercode",
      body: { client_id: CONFIG.clientId, scope: OPENAI_SCOPES.join(" "), code_challenge: "challenge-1", code_challenge_method: "S256" },
    });
    expect(device).toEqual({ userCode: "WDJB-MJHT", deviceAuthId: "da-1", verificationUri: "https://auth.openai.com/device" });
  });

  test("poll keeps waiting on pending, returns code + server-side verifier", async () => {
    const fetchImpl = endpoint([
      { status: 400, json: { error: "authorization_pending" } },
      { status: 200, json: { authorization_code: "device-code", code_verifier: "server-verifier" } },
    ]);
    const polled = await pollOpenaiDeviceToken(
      CONFIG,
      { deviceAuthId: "da-1", userCode: "WDJB-MJHT" },
      { fetchImpl, pollIntervalMs: 1, sleep: async () => {} },
    );
    expect(fetchImpl.calls[0]).toMatchObject({
      url: "https://auth.openai.com/deviceauth/token",
      body: { device_auth_id: "da-1", user_code: "WDJB-MJHT" },
    });
    expect(polled).toEqual({ code: "device-code", codeVerifier: "server-verifier" });
  });

  test("terminal polling error fails fast", async () => {
    const fetchImpl = endpoint([{ status: 200, json: { error: "access_denied" } }]);
    await expect(
      pollOpenaiDeviceToken(CONFIG, { deviceAuthId: "da-1", userCode: "c" }, { fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow(/access_denied/);
  });

  test("timeout returns empty code", async () => {
    const fetchImpl = endpoint([{ status: 400, json: { error: "authorization_pending" } }]);
    let t = 0;
    const polled = await pollOpenaiDeviceToken(
      CONFIG,
      { deviceAuthId: "da-1", userCode: "c" },
      { fetchImpl, pollIntervalMs: 1, timeoutMs: 100, now: () => (t += 50), sleep: async () => {} },
    );
    expect(polled.code).toBe("");
  });
});

function loginIoDouble(answers: string[]): AuthorizationIo & { infos: string[]; openedUrls: string[] } {
  let i = 0;
  const infos: string[] = [];
  const openedUrls: string[] = [];
  return {
    ask: async (prompt) => {
      infos.push(prompt);
      return answers[i++] ?? "";
    },
    info: async (line) => {
      infos.push(line);
    },
    openUrl: async (url) => {
      openedUrls.push(url);
      return true;
    },
    infos,
    openedUrls,
  };
}

describe("loginOpenAI", () => {
  const loginResults = () => endpoint([
    { status: 200, json: { user_code: "WDJB-MJHT", device_auth_id: "da-1", verification_uri: "https://auth.openai.com/device" } },
    { status: 200, json: { authorization_code: "device-code" } },
    { status: 200, json: TOKEN_RESPONSE },
    { status: 200, json: MINT_RESPONSE },
  ]);

  test("ToS declined aborts before any network I/O", async () => {
    const io = loginIoDouble(["n"]);
    const fetchImpl = loginResults();
    await expect(loginOpenAI(io, { fetchImpl })).rejects.toBeInstanceOf(OpenAiLoginAborted);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("device path (headless): usercode → poll → exchange → mint", async () => {
    const io = loginIoDouble(["y", "n"]);
    const fetchImpl = loginResults();
    const token = await loginOpenAI(io, { fetchImpl, now: NOW, pollIntervalMs: 1 });
    // The user code is shown for manual entry on any machine's browser.
    expect(io.infos.join("\n")).toContain("WDJB-MJHT");
    expect(io.infos.join("\n")).toContain("https://auth.openai.com/device");
    // Exchange uses the loopback redirect_uri shape, mint returns the key.
    expect(fetchImpl.calls[2]!.body).toMatchObject({ grant_type: "authorization_code", code: "device-code" });
    expect(token.accessToken).toBe("sk-minted-1");
    expect(token.grant).toMatchObject({ provider: "openai", minted: true });
  });

  test("device timeout fails loudly", async () => {
    const io = loginIoDouble(["y", "n"]);
    const fetchImpl: OpenAiEndpointFetch = async (url) =>
      url.endsWith("/deviceauth/usercode")
        ? { status: 200, json: { user_code: "WDJB-MJHT", device_auth_id: "da-1" } }
        : { status: 400, json: { error: "authorization_pending" } };
    await expect(
      loginOpenAI(io, { fetchImpl, now: NOW, pollIntervalMs: 1, timeoutMs: 50, sleep: async () => {} }),
    ).rejects.toThrow(/device code timed out/);
  });

  test("browser path: loopback on 1455/1457 with /auth/callback, callback delivers the code", async () => {
    // ToS = y, browser = y; no paste prompt exists for OpenAI, so the
    // callback is the only code source.
    let asked = 0;
    const infos: string[] = [];
    const openedUrls: string[] = [];
    const io: AuthorizationIo = {
      ask: async () => {
        asked += 1;
        return asked <= 1 ? "y" : "y";
      },
      info: async (line) => {
        infos.push(line);
      },
      openUrl: async (url) => {
        openedUrls.push(url);
        return true;
      },
    };
    const fetchImpl = endpoint([
      { status: 200, json: TOKEN_RESPONSE },
      { status: 200, json: MINT_RESPONSE },
    ]);
    const login = loginOpenAI(io, { fetchImpl, now: NOW, timeoutMs: 3000 });

    while (openedUrls.length === 0) await Bun.sleep(5);
    const authorize = new URL(openedUrls[0]!);
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    const redirectUri = authorize.searchParams.get("redirect_uri")!;
    await fetch(`${redirectUri}?code=browser-code&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`);

    const token = await login;
    expect(token.accessToken).toBe("sk-minted-1");
    expect(fetchImpl.calls[0]!.body).toMatchObject({ code: "browser-code", redirect_uri: redirectUri });
  });
});
