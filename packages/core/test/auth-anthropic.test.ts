import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_OAUTH_DEFAULTS,
  ANTHROPIC_SUBSCRIPTION_SCOPES,
  AnthropicLoginAborted,
  buildAnthropicAuthorizeUrl,
  exchangeAnthropicCode,
  loginAnthropic,
  refreshAnthropicToken,
  resolveAnthropicOAuthConfig,
  type TokenEndpointFetch,
} from "../src/auth/anthropic";
import { anthropicAuthOverridesSchema, authSectionSchema } from "../src/auth/types";
import { anthropicSubscriptionHeaders } from "../src/providers/ai-sdk";
import { Endpoint } from "../src/route";
import { raceForCode, startLoopbackCallback, generateState, type AuthorizationIo } from "../src/auth/oauth";
import type { AuthToken } from "../src/auth/types";

const CONFIG = resolveAnthropicOAuthConfig();
const NOW = 1_700_000_000_000;


/** Scripts the token endpoint: per-call results in order. */
function tokenEndpoint(
  results: Array<{ status: number; json: Record<string, unknown> }>,
): TokenEndpointFetch & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const fn: TokenEndpointFetch = async (_url, body) => {
    calls.push(body);
    return results[i++] ?? { status: 500, json: {} };
  };
  return Object.assign(fn, { calls });
}

const OK_RESPONSE = {
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_in: 3600,
  scope: "user:inference",
  account: { uuid: "uuid-1", email_address: "me@example.com" },
  organization: { uuid: "org-1" },
};

describe("anthropic config + overrides", () => {
  test("captured defaults match the Claude Code source (drift watch)", () => {
    expect(ANTHROPIC_OAUTH_DEFAULTS.authorizeUrl).toBe("https://claude.com/cai/oauth/authorize");
    expect(ANTHROPIC_OAUTH_DEFAULTS.tokenUrl).toBe("https://platform.claude.com/v1/oauth/token");
    expect(ANTHROPIC_OAUTH_DEFAULTS.clientId).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(ANTHROPIC_OAUTH_DEFAULTS.manualRedirectUrl).toBe("https://platform.claude.com/oauth/code/callback");
  });

  test("overrides win over defaults; absent fields keep defaults", () => {
    const config = resolveAnthropicOAuthConfig({ tokenUrl: "https://mirror.example/token", inferenceExpiresIn: 7200 });
    expect(config.tokenUrl).toBe("https://mirror.example/token");
    expect(config.authorizeUrl).toBe(ANTHROPIC_OAUTH_DEFAULTS.authorizeUrl);
    expect(config.inferenceExpiresIn).toBe(7200);
  });

  test("overrides schema validates the auth section shape", () => {
    const section = authSectionSchema.parse({
      tokens: {},
      overrides: { anthropic: { clientId: "custom-id" } },
    });
    expect(section.overrides?.anthropic?.clientId).toBe("custom-id");
    expect(anthropicAuthOverridesSchema.safeParse({ authorizeUrl: "not a url" }).success).toBe(false);
  });
});

describe("buildAnthropicAuthorizeUrl", () => {
  const base = { codeChallenge: "challenge-1", state: "state-1" };

  test("inferenceOnly: scope shrinks to user:inference, loopback redirect", () => {
    const url = new URL(
      buildAnthropicAuthorizeUrl(CONFIG, { ...base, redirectUri: "http://localhost:54321/callback", inferenceOnly: true }),
    );
    expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("user:inference");
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:54321/callback");
  });

  test("default variant: full subscriber scopes, hosted manual redirect", () => {
    const url = new URL(
      buildAnthropicAuthorizeUrl(CONFIG, { ...base, redirectUri: CONFIG.manualRedirectUrl, inferenceOnly: false }),
    );
    expect(url.searchParams.get("scope")).toBe(ANTHROPIC_SUBSCRIPTION_SCOPES.join(" "));
    expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
  });
});

describe("exchangeAnthropicCode", () => {
  const exchange = {
    code: "auth-code",
    codeVerifier: "verifier",
    state: "state-1",
    redirectUri: "http://localhost:1234/callback",
  };

  test("inference exchange requests expires_in; scope stays in the authorize URL only (Claude Code shape)", async () => {
    const fetchImpl = tokenEndpoint([{ status: 200, json: OK_RESPONSE }]);
    const token = await exchangeAnthropicCode(CONFIG, { ...exchange, inferenceOnly: true, fetchImpl, now: NOW });
    expect(fetchImpl.calls[0]).toMatchObject({
      grant_type: "authorization_code",
      code: "auth-code",
      redirect_uri: "http://localhost:1234/callback",
      client_id: CONFIG.clientId,
      code_verifier: "verifier",
      state: "state-1",
      expires_in: CONFIG.inferenceExpiresIn,
    });
    expect("scope" in fetchImpl.calls[0]!).toBe(false);
    expect(token).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: NOW + 3600 * 1000,
      scopes: ["user:inference"],
      account: { id: "uuid-1", email: "me@example.com" },
      grant: { inferenceOnly: true },
      updatedAt: NOW,
    });
  });

  test("silent fallback: rejected long-lived request retries without expires_in, same code/scopes", async () => {
    const fetchImpl = tokenEndpoint([
      { status: 400, json: { error: "unsupported expires_in" } },
      { status: 200, json: { ...OK_RESPONSE, expires_in: 3600, scope: ANTHROPIC_SUBSCRIPTION_SCOPES.join(" ") } },
    ]);
    const token = await exchangeAnthropicCode(CONFIG, { ...exchange, inferenceOnly: true, fetchImpl, now: NOW });
    expect(fetchImpl.calls).toHaveLength(2);
    expect(fetchImpl.calls[1]).toMatchObject({ code: "auth-code" });
    expect("expires_in" in fetchImpl.calls[1]!).toBe(false);
    expect("scope" in fetchImpl.calls[1]!).toBe(false);
    expect(token.grant).toEqual({ inferenceOnly: false }); // full scope set granted
  });

  test("server-capped expires_in is accepted as-is (normal refresh covers it)", async () => {
    const fetchImpl = tokenEndpoint([{ status: 200, json: { ...OK_RESPONSE, expires_in: 3600 } }]);
    const token = await exchangeAnthropicCode(CONFIG, { ...exchange, inferenceOnly: true, fetchImpl, now: NOW });
    expect(token.expiresAt).toBe(NOW + 3600 * 1000);
    expect(token.grant).toEqual({ inferenceOnly: true });
  });

  test("non-200 after fallback throws", async () => {
    const fetchImpl = tokenEndpoint([{ status: 401, json: { error: "invalid_grant" } }]);
    await expect(
      exchangeAnthropicCode(CONFIG, { ...exchange, inferenceOnly: false, fetchImpl, now: NOW }),
    ).rejects.toThrow(/token exchange failed \(401\)/);
  });
});

describe("refreshAnthropicToken", () => {
  const stored: AuthToken = {
    accessToken: "at-old",
    refreshToken: "rt-old",
    expiresAt: NOW - 1000,
    scopes: ["user:inference"],
    account: { id: "uuid-1", email: "me@example.com" },
    grant: { inferenceOnly: true },
    updatedAt: NOW - 10_000,
  };

  test("refresh grant posts scope + client_id; new refresh token wins", async () => {
    const fetchImpl = tokenEndpoint([
      { status: 200, json: { ...OK_RESPONSE, access_token: "at-new", refresh_token: "rt-rotated", scope: "user:profile user:inference" } },
    ]);
    const fresh = await refreshAnthropicToken(CONFIG, stored, { fetchImpl, now: NOW });
    expect(fetchImpl.calls[0]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-old",
      client_id: CONFIG.clientId,
      scope: "user:inference", // scope expansion allowed; stored scopes requested
    });
    expect(fresh.accessToken).toBe("at-new");
    expect(fresh.refreshToken).toBe("rt-rotated");
    expect(fresh.scopes).toEqual(["user:profile", "user:inference"]); // expanded
    expect(fresh.grant).toEqual({ inferenceOnly: false }); // recomputed from expanded scopes
    expect(fresh.account).toEqual({ id: "uuid-1", email: "me@example.com" }); // carried over
  });

  test("scope expansion on refresh flips the inferenceOnly grant metadata", async () => {
    const fetchImpl = tokenEndpoint([
      { status: 200, json: { ...OK_RESPONSE, refresh_token: "rt-2", scope: "user:profile user:inference" } },
    ]);
    const fresh = await refreshAnthropicToken(CONFIG, stored, { fetchImpl, now: NOW });
    expect(fresh.grant).toEqual({ inferenceOnly: false });
  });

  test("missing refresh_token in the response keeps the old one", async () => {
    const fetchImpl = tokenEndpoint([{ status: 200, json: { access_token: "at-new", expires_in: 60 } }]);
    const fresh = await refreshAnthropicToken(CONFIG, stored, { fetchImpl, now: NOW });
    expect(fresh.refreshToken).toBe("rt-old");
  });

  test("no stored refresh token is a re-login error", async () => {
    await expect(
      refreshAnthropicToken(CONFIG, { ...stored, refreshToken: undefined }, { now: NOW }),
    ).rejects.toThrow(/no refresh token.*moh provider login/);
  });

  test("refresh failure carries the re-login hint", async () => {
    const fetchImpl = tokenEndpoint([{ status: 400, json: { error: "invalid_grant" } }]);
    await expect(refreshAnthropicToken(CONFIG, stored, { fetchImpl, now: NOW })).rejects.toThrow(
      /refresh failed \(400\).*moh provider login/,
    );
  });
});

function loginIoDouble(answers: string[], opts: { noBrowser?: boolean } = {}): AuthorizationIo & { infos: string[]; openedUrls: string[] } {
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
        if (opts.noBrowser) throw new Error("no browser");
        return true;
      },
      infos,
      openedUrls,
    };
  }

describe("loginAnthropic", () => {
  const tokenResults = () => tokenEndpoint([{ status: 200, json: OK_RESPONSE }]);

  test("ToS declined aborts before any network I/O", async () => {
    const io = loginIoDouble(["n"]);
    const fetchImpl = tokenResults();
    await expect(loginAnthropic(io, { fetchImpl })).rejects.toBeInstanceOf(AnthropicLoginAborted);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("paste path: manual redirect_uri used for the exchange", async () => {
    const io = loginIoDouble(["y", "pasted-code", ""], { noBrowser: true }); // headless: the paste path is the winner
    const fetchImpl = tokenResults();
    const token = await loginAnthropic(io, {
      fetchImpl,
      now: NOW,
      overrides: {
        authorizeUrl: "https://claude.example/authorize",
        tokenUrl: "https://claude.example/token",
        manualRedirectUrl: "https://claude.example/code/callback",
      },
    });
    expect(token.accessToken).toBe("at-1");
    // The URL shown to the user is the manual (hosted-redirect) authorize
    // request; openUrl receives the loopback-redirect variant of the same
    // request — both share state and code_challenge (one PKCE pair).
    const shown = io.infos.join("\n").match(/https:\/\/claude\.example\/authorize\?[^\s]+/)![0];
    const shownParams = new URL(shown).searchParams;
    expect(shownParams.get("redirect_uri")).toBe("https://claude.example/code/callback");
    expect(io.openedUrls).toHaveLength(1);
    const automatic = new URL(io.openedUrls[0]!);
    expect(automatic.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(shownParams.get("state")).toBe(automatic.searchParams.get("state"));
    expect(shownParams.get("code_challenge")).toBe(automatic.searchParams.get("code_challenge"));
    expect(fetchImpl.calls[0]).toMatchObject({
      redirect_uri: "https://claude.example/code/callback",
      expires_in: ANTHROPIC_OAUTH_DEFAULTS.inferenceExpiresIn,
    });
  });

  test("callback path: loopback redirect_uri used for the exchange", async () => {
    // ToS = y; the paste prompt blocks (user is off in the browser), so only
    // the loopback callback can deliver the code — deterministic winner.
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
    const login = loginAnthropic(io, { fetchImpl, now: NOW, timeoutMs: 2000 });

    // Wait for openUrl (loopback is up by then), then deliver via HTTP callback.
    while (openedUrls.length === 0) await Bun.sleep(5);
    const automatic = new URL(openedUrls[0]!);
    const redirectUri = automatic.searchParams.get("redirect_uri")!;
    await fetch(`${redirectUri}?code=browser-code&state=${encodeURIComponent(automatic.searchParams.get("state")!)}`);
    releasePaste?.(""); // unblock the abandoned paste prompt

    const token = await login;
    expect(token.accessToken).toBe("at-1");
    expect(fetchImpl.calls[0]).toMatchObject({ code: "browser-code", redirect_uri: redirectUri });
  });

  test("no code delivered (cancel/timeout) fails loudly", async () => {
    const io = loginIoDouble(["y", "", ""]);
    const fetchImpl = tokenResults();
    await expect(
      loginAnthropic(io, { fetchImpl, now: NOW, timeoutMs: 100 }),
    ).rejects.toThrow(/no authorization code received/);
  });
});

describe("anthropic adapter beta header", () => {
  test("subscription endpoints get anthropic-beta: claude-code-20250219,oauth-2025-04-20", () => {
    expect(anthropicSubscriptionHeaders("subscription")).toEqual(ANTHROPIC_OAUTH_BETA);
  });

  test("api-key endpoints get no extra headers (byte-identical invariant)", () => {
    expect(anthropicSubscriptionHeaders("api-key")).toBeUndefined();
  });

  test("Endpoint defaults to api-key; profile auth flows through", () => {
    expect(new Endpoint({ name: "e", kind: "anthropic" }).authKind).toBe("api-key");
    expect(new Endpoint({ name: "e", kind: "anthropic", auth: { kind: "subscription" } }).authKind).toBe("subscription");
  });
});

describe("oauth seam: code source tracking", () => {
  test("deliveredViaCallback flips on the automatic path, stays false on paste", async () => {
    // Paste path
    const io = loginIoDouble(["pasted", ""]);
    const server = await startLoopbackCallback({ state: generateState(), timeoutMs: 1000 });
    await raceForCode(loginIoDouble([""]), { authorizeUrl: "https://m/a", manualUrl: "https://m/cb", callback: server });
    expect(server.deliveredViaCallback).toBe(false);

    // Callback path
    const state = generateState();
    const server2 = await startLoopbackCallback({ state, timeoutMs: 1000 });
    const raced = raceForCode(loginIoDouble([""]), {
      authorizeUrl: "https://m/a",
      manualUrl: "https://m/cb",
      callback: server2,
    });
    await Bun.sleep(10);
    expect(server2.deliveredViaCallback).toBe(false); // nothing delivered yet
    await fetch(`${server2.redirectUri}?code=c1&state=${encodeURIComponent(state)}`);
    await raced;
    expect(server2.deliveredViaCallback).toBe(true);
  });
});
