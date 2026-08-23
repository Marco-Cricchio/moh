import { describe, expect, test } from "bun:test";
import {
  GOOGLE_OAUTH_DEFAULTS,
  GOOGLE_API_BASE_URL,
  GOOGLE_SCOPES,
  GoogleLoginAborted,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  loginGoogle,
  refreshGoogleToken,
  resolveGoogleOAuthConfig,
  type GoogleEndpointFetch,
} from "../src/auth/google";
import { googleAuthOverridesSchema, authSectionSchema } from "../src/auth/types";
import { raceForCode, startLoopbackCallback, generateState, type AuthorizationIo } from "../src/auth/oauth";
import type { AuthToken } from "../src/auth/types";

const CONFIG = resolveGoogleOAuthConfig();
const NOW = 1_700_000_000_000;

/** Scripts the token endpoint: per-call results in order. */
function tokenEndpoint(
  results: Array<{ status: number; json: Record<string, unknown> }>,
): GoogleEndpointFetch & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const fn: GoogleEndpointFetch = async (_url, body) => {
    calls.push(body);
    return results[i++] ?? { status: 500, json: {} };
  };
  return Object.assign(fn, { calls });
}

/** id_token with email + name claims (display-only, unverified decode). */
const ID_TOKEN = `header.${Buffer.from(
  JSON.stringify({ email: "me@gmail.com", name: "Me" }),
  "utf8",
).toString("base64url")}.signature`;

const OK_RESPONSE = {
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_in: 3600,
  scope: GOOGLE_SCOPES.join(" "),
  id_token: ID_TOKEN,
};

describe("google config + overrides", () => {
  test("captured defaults match the gemini-cli source (drift watch)", () => {
    expect(GOOGLE_OAUTH_DEFAULTS.authorizeUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(GOOGLE_OAUTH_DEFAULTS.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(GOOGLE_OAUTH_DEFAULTS.clientId).toBe(
      "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    );
    // Installed-app secret: Google's own guidance treats it as a non-secret.
    expect(GOOGLE_OAUTH_DEFAULTS.clientSecret).toBe("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");
    expect(GOOGLE_OAUTH_DEFAULTS.manualRedirectUrl).toBe("https://codeassist.google.com/authcode");
    expect(GOOGLE_API_BASE_URL).toBe("https://cloudcode-pa.googleapis.com/v1internal");
  });

  test("overrides win over defaults; absent fields keep defaults", () => {
    const config = resolveGoogleOAuthConfig({ tokenUrl: "https://mirror.example/token", clientId: "custom-id" });
    expect(config.tokenUrl).toBe("https://mirror.example/token");
    expect(config.clientId).toBe("custom-id");
    expect(config.authorizeUrl).toBe(GOOGLE_OAUTH_DEFAULTS.authorizeUrl);
    expect(config.clientSecret).toBe(GOOGLE_OAUTH_DEFAULTS.clientSecret);
  });

  test("overrides schema validates the auth section shape", () => {
    const section = authSectionSchema.parse({
      tokens: {},
      overrides: { google: { clientId: "custom-id" } },
    });
    expect(section.overrides?.google?.clientId).toBe("custom-id");
    expect(googleAuthOverridesSchema.safeParse({ authorizeUrl: "not a url" }).success).toBe(false);
  });
});

describe("buildGoogleAuthorizeUrl", () => {
  const base = { state: "state-1" };

  test("browser path: state-only (no PKCE), loopback IP redirect, offline access", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl(CONFIG, {
        ...base,
        redirectUri: "http://127.0.0.1:54321/oauth2callback",
        codeChallenge: undefined,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/oauth2callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBeNull(); // gemini-cli: state-only here
  });

  test("manual path: PKCE S256 against the out-of-band authcode page", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl(CONFIG, {
        ...base,
        redirectUri: CONFIG.manualRedirectUrl,
        codeChallenge: "challenge-1",
      }),
    );
    expect(url.searchParams.get("redirect_uri")).toBe("https://codeassist.google.com/authcode");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeGoogleCode", () => {
  test("browser-path exchange: no code_verifier, client_secret included", async () => {
    const fetchImpl = tokenEndpoint([{ status: 200, json: OK_RESPONSE }]);
    const token = await exchangeGoogleCode(CONFIG, {
      code: "auth-code",
      redirectUri: "http://127.0.0.1:1234/oauth2callback",
      codeVerifier: undefined,
      fetchImpl,
      now: NOW,
    });
    expect(fetchImpl.calls[0]).toMatchObject({
      grant_type: "authorization_code",
      code: "auth-code",
      redirect_uri: "http://127.0.0.1:1234/oauth2callback",
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
    });
    expect("code_verifier" in fetchImpl.calls[0]!).toBe(false);
    expect(token).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: NOW + 3600 * 1000,
      scopes: [...GOOGLE_SCOPES],
      account: { email: "me@gmail.com", name: "Me" },
      grant: { provider: "google" },
      updatedAt: NOW,
    });
  });

  test("manual-path exchange carries code_verifier (PKCE used there)", async () => {
    const fetchImpl = tokenEndpoint([{ status: 200, json: OK_RESPONSE }]);
    await exchangeGoogleCode(CONFIG, {
      code: "pasted-code",
      redirectUri: CONFIG.manualRedirectUrl,
      codeVerifier: "verifier",
      fetchImpl,
      now: NOW,
    });
    expect(fetchImpl.calls[0]).toMatchObject({ code: "pasted-code", code_verifier: "verifier" });
  });

  test("non-200 throws with status and body", async () => {
    const fetchImpl = tokenEndpoint([{ status: 400, json: { error: "invalid_grant" } }]);
    await expect(
      exchangeGoogleCode(CONFIG, {
        code: "auth-code",
        redirectUri: CONFIG.manualRedirectUrl,
        fetchImpl,
        now: NOW,
      }),
    ).rejects.toThrow(/token exchange failed \(400\)/);
  });

  test("missing refresh_token tolerated (Google may omit it on repeat grants)", async () => {
    const fetchImpl = tokenEndpoint([{ status: 200, json: { ...OK_RESPONSE, refresh_token: undefined } }]);
    const token = await exchangeGoogleCode(CONFIG, {
      code: "auth-code",
      redirectUri: CONFIG.manualRedirectUrl,
      fetchImpl,
      now: NOW,
    });
    expect(token.refreshToken).toBeUndefined();
  });
});

describe("refreshGoogleToken", () => {
  const stored: AuthToken = {
    accessToken: "at-old",
    refreshToken: "rt-old",
    expiresAt: NOW - 1000,
    scopes: [...GOOGLE_SCOPES],
    account: { email: "me@gmail.com", name: "Me" },
    grant: { provider: "google" },
    updatedAt: NOW - 10_000,
  };

  test("refresh grant posts client_secret; account carries over", async () => {
    const fetchImpl = tokenEndpoint([
      { status: 200, json: { ...OK_RESPONSE, access_token: "at-new", id_token: undefined } },
    ]);
    const fresh = await refreshGoogleToken(CONFIG, stored, { fetchImpl, now: NOW });
    expect(fetchImpl.calls[0]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-old",
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
    });
    expect(fresh.accessToken).toBe("at-new");
    expect(fresh.account).toEqual({ email: "me@gmail.com", name: "Me" }); // carried over
    expect(fresh.grant).toEqual({ provider: "google" });
  });

  test("new refresh token wins; missing one keeps the old", async () => {
    const rotated = tokenEndpoint([{ status: 200, json: { ...OK_RESPONSE, refresh_token: "rt-rotated", id_token: undefined } }]);
    const fresh = await refreshGoogleToken(CONFIG, stored, { fetchImpl: rotated, now: NOW });
    expect(fresh.refreshToken).toBe("rt-rotated");
    const kept = tokenEndpoint([{ status: 200, json: { access_token: "at-2", id_token: undefined } }]);
    const fresh2 = await refreshGoogleToken(CONFIG, stored, { fetchImpl: kept, now: NOW });
    expect(fresh2.refreshToken).toBe("rt-old");
  });

  test("no stored refresh token is a re-login error", async () => {
    await expect(
      refreshGoogleToken(CONFIG, { ...stored, refreshToken: undefined }, { now: NOW }),
    ).rejects.toThrow(/no refresh token.*moh provider login/);
  });

  test("refresh failure carries the re-login hint", async () => {
    const fetchImpl = tokenEndpoint([{ status: 400, json: { error: "invalid_grant" } }]);
    await expect(refreshGoogleToken(CONFIG, stored, { fetchImpl, now: NOW })).rejects.toThrow(
      /refresh failed \(400\).*moh provider login/,
    );
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

describe("loginGoogle", () => {
  const tokenResults = () => tokenEndpoint([{ status: 200, json: OK_RESPONSE }]);

  test("ToS declined aborts before any network I/O", async () => {
    const io = loginIoDouble(["n"]);
    const fetchImpl = tokenResults();
    await expect(loginGoogle(io, { fetchImpl })).rejects.toBeInstanceOf(GoogleLoginAborted);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("paste path: loopback IP + PKCE manual URL shown; authcode redirect used for the exchange", async () => {
    const io = loginIoDouble(["y", "pasted-code", ""]);
    const fetchImpl = tokenResults();
    const token = await loginGoogle(io, { fetchImpl, now: NOW });
    expect(token.accessToken).toBe("at-1");
    // Shown URL = manual variant (PKCE + authcode redirect page); openUrl
    // gets the browser variant (state-only, loopback IP redirect).
    const shown = io.infos.join("\n").match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s]+/)![0];
    const shownParams = new URL(shown).searchParams;
    expect(shownParams.get("redirect_uri")).toBe("https://codeassist.google.com/authcode");
    expect(shownParams.get("code_challenge_method")).toBe("S256");
    expect(io.openedUrls).toHaveLength(1);
    const automatic = new URL(io.openedUrls[0]!);
    // Loopback IP literal (Google "Desktop app" policy), ephemeral port.
    expect(automatic.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(automatic.searchParams.get("code_challenge")).toBeNull();
    expect(shownParams.get("state")).toBe(automatic.searchParams.get("state"));
    // Exchange: pasted code → authcode redirect_uri + the PKCE verifier.
    expect(fetchImpl.calls[0]).toMatchObject({
      code: "pasted-code",
      redirect_uri: "https://codeassist.google.com/authcode",
      code_verifier: expect.any(String),
    });
  });

  test("callback path: loopback redirect_uri, no code_verifier in the exchange", async () => {
    // ToS = y; the paste prompt blocks, so only the loopback callback
    // delivers — deterministic winner.
    let releasePaste: ((v: string) => void) | undefined;
    const infos: string[] = [];
    const openedUrls: string[] = [];
    let asked = 0;
    const io: AuthorizationIo = {
      ask: async () => {
        asked += 1;
        if (asked === 1) return "y"; // ToS acknowledgement
        return new Promise<string>((resolve) => {
          releasePaste = resolve;
        });
      },
      info: async (line) => {
        infos.push(line);
      },
      openUrl: async (url) => {
        openedUrls.push(url);
        return true;
      },
    };
    const fetchImpl = tokenResults();
    const login = loginGoogle(io, { fetchImpl, now: NOW, timeoutMs: 2000 });

    while (openedUrls.length === 0) await Bun.sleep(5);
    const automatic = new URL(openedUrls[0]!);
    const redirectUri = automatic.searchParams.get("redirect_uri")!;
    await fetch(`${redirectUri}?code=browser-code&state=${encodeURIComponent(automatic.searchParams.get("state")!)}`);
    releasePaste?.("");

    const token = await login;
    expect(token.accessToken).toBe("at-1");
    expect(fetchImpl.calls[0]).toMatchObject({ code: "browser-code", redirect_uri: redirectUri });
    expect("code_verifier" in fetchImpl.calls[0]!).toBe(false);
  });

  test("no code delivered (cancel/timeout) fails loudly", async () => {
    const io = loginIoDouble(["y", "", ""]);
    const fetchImpl = tokenResults();
    await expect(loginGoogle(io, { fetchImpl, now: NOW, timeoutMs: 100 })).rejects.toThrow(
      /no authorization code received/,
    );
  });
});

describe("oauth seam reuse (regression: google rides the generic machinery)", () => {
  test("raceForCode works against a 127.0.0.1 loopback server", async () => {
    const state = generateState();
    const server = await startLoopbackCallback({ state, host: "127.0.0.1", callbackPath: "/oauth2callback", timeoutMs: 1000 });
    const raced = raceForCode(loginIoDouble([""]), {
      authorizeUrl: "https://m/a",
      manualUrl: "https://m/cb",
      callback: server,
    });
    await fetch(`${server.redirectUri}?code=c1&state=${encodeURIComponent(state)}`);
    expect(await raced).toBe("c1");
  });
});
