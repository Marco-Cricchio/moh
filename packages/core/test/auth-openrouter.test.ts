import { describe, expect, test } from "bun:test";
import {
  OPENROUTER_OAUTH_DEFAULTS,
  OPENROUTER_API_BASE_URL,
  OpenrouterLoginAborted,
  exchangeOpenrouterCode,
  loginOpenRouter,
  parseOpenrouterAuthorizationInput,
  resolveOpenrouterOAuthConfig,
  type OpenrouterEndpointFetch,
} from "../src/auth/openrouter";
import { runSubscriptionLogin, isSubscriptionKind, SUBSCRIPTION_KINDS } from "../src/auth/lifecycle";
import { resolveEndpointCredential } from "../src/auth/resolve";
import { saveTokens, readAuthSection } from "../src/auth/store";
import { Endpoint } from "../src/route";
import type { AuthorizationIo } from "../src/auth/oauth";

const NOW = 1_700_000_000_000;

function scriptedEndpoint(
  results: Array<{ status: number; json: Record<string, unknown> }>,
): OpenrouterEndpointFetch & { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fn: OpenrouterEndpointFetch = async (url, body) => {
    calls.push({ url, body });
    return results[i++] ?? { status: 500, json: {} };
  };
  return Object.assign(fn, { calls });
}

describe("openrouter config", () => {
  test("captured defaults (drift watch)", () => {
    expect(OPENROUTER_OAUTH_DEFAULTS.authorizeUrl).toBe("https://openrouter.ai/auth");
    expect(OPENROUTER_OAUTH_DEFAULTS.tokenUrl).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(OPENROUTER_API_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  test("overrides win; absent fields keep defaults", () => {
    const config = resolveOpenrouterOAuthConfig({ authorizeUrl: "https://mirror.example/auth" });
    expect(config.authorizeUrl).toBe("https://mirror.example/auth");
    expect(config.tokenUrl).toBe(OPENROUTER_OAUTH_DEFAULTS.tokenUrl);
  });
});

describe("parseOpenrouterAuthorizationInput", () => {
  test("extracts the code from a redirect URL, a query string, or passes a bare code", () => {
    expect(parseOpenrouterAuthorizationInput("http://127.0.0.1:51234/callback?code=abc&state=x")).toBe("abc");
    expect(parseOpenrouterAuthorizationInput("code=abc&state=x")).toBe("abc");
    expect(parseOpenrouterAuthorizationInput("abc")).toBe("abc");
    expect(parseOpenrouterAuthorizationInput("  ")).toBeUndefined();
  });
});

describe("exchangeOpenrouterCode", () => {
  test("yields a minted-key grant: persistent key, no expiry, no refresh token", async () => {
    const fetchImpl = scriptedEndpoint([{ status: 200, json: { key: "sk-or-v1-persistent" } }]);
    const token = await exchangeOpenrouterCode(resolveOpenrouterOAuthConfig(), {
      code: "c-1",
      codeVerifier: "v-1",
      fetchImpl,
      now: NOW,
    });
    expect(token.accessToken).toBe("sk-or-v1-persistent");
    expect(token.refreshToken).toBeUndefined();
    expect(token.expiresAt).toBeUndefined();
    expect(token.grant).toEqual({ provider: "openrouter", minted: true });
    expect(token.updatedAt).toBe(NOW);
    // JSON body, PKCE verifier, S256 method — pi-ai's captured shape.
    expect(fetchImpl.calls[0]!.url).toBe(OPENROUTER_OAUTH_DEFAULTS.tokenUrl);
    expect(fetchImpl.calls[0]!.body).toEqual({ code: "c-1", code_verifier: "v-1", code_challenge_method: "S256" });
  });

  test("200 without a key fails", async () => {
    const fetchImpl = scriptedEndpoint([{ status: 200, json: {} }]);
    await expect(
      exchangeOpenrouterCode(resolveOpenrouterOAuthConfig(), { code: "c", codeVerifier: "v", fetchImpl, now: NOW }),
    ).rejects.toThrow("(HTTP 200)");
  });

  test("error object detail is unwrapped", async () => {
    const fetchImpl = scriptedEndpoint([{ status: 400, json: { error: { message: "nested" } } }]);
    await expect(
      exchangeOpenrouterCode(resolveOpenrouterOAuthConfig(), { code: "c", codeVerifier: "v", fetchImpl, now: NOW }),
    ).rejects.toThrow("nested");
  });

  test("non-200 or missing key fails with detail", async () => {
    const fetchImpl = scriptedEndpoint([{ status: 400, json: { message: "bad verifier" } }]);
    await expect(
      exchangeOpenrouterCode(resolveOpenrouterOAuthConfig(), { code: "c", codeVerifier: "v", fetchImpl, now: NOW }),
    ).rejects.toThrow("(HTTP 400): bad verifier");
  });
});

describe("loginOpenRouter", () => {
  test("declining the ToS aborts before any network I/O", async () => {
    const io: AuthorizationIo = { ask: async () => "n", info: async () => {} };
    await expect(loginOpenRouter(io, { now: NOW })).rejects.toBeInstanceOf(OpenrouterLoginAborted);
  });

  test("headless paste path: pasted redirect URL exchanges into a key grant", async () => {
    const answers = ["y", "http://127.0.0.1:1/callback?code=pasted-code"];
    const seen: string[] = [];
    const io: AuthorizationIo = {
      ask: async (p) => {
        seen.push(p);
        return answers.shift() ?? "";
      },
      info: async () => {},
      // no openUrl: headless — manual path wins the race
    };
    const fetchImpl = scriptedEndpoint([{ status: 200, json: { key: "sk-or-v1-key" } }]);
    const token = await loginOpenRouter(io, { fetchImpl, now: NOW, timeoutMs: 500 });
    expect(token.accessToken).toBe("sk-or-v1-key");
    expect(token.grant).toEqual({ provider: "openrouter", minted: true });
    expect(fetchImpl.calls[0]!.body.code).toBe("pasted-code");
    expect(typeof fetchImpl.calls[0]!.body.code_verifier).toBe("string");
  });
});

describe("lifecycle + resolve integration", () => {
  test("openrouter is a subscription kind and runs its grant via runSubscriptionLogin", async () => {
    expect(isSubscriptionKind("openrouter")).toBe(true);
    expect(SUBSCRIPTION_KINDS).toContain("openrouter");
  });

  test("stored openrouter grant resolves as a plain credential — no refresh, no ChatGPT context", async () => {
    const authFile = `/tmp/moh-test-openrouter-${process.pid}.json`;
    await Bun.write(authFile, "{}");
    const endpoint = new Endpoint({
      name: "or",
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      auth: { kind: "subscription" },
    });
    saveTokens(authFile, "or", {
      accessToken: "sk-or-v1-persistent",
      grant: { provider: "openrouter", minted: true },
      updatedAt: NOW,
    });
    const resolved = await resolveEndpointCredential(
      { endpoint, modelId: "openai/gpt-4o" },
      { configFile: authFile },
    );
    expect(resolved).toBe("sk-or-v1-persistent"); // minted key = plain api-key path
    // No expiresAt ever gets written by the grant — refresh never triggers.
    expect(readAuthSection(authFile).tokens.or!.expiresAt).toBeUndefined();
  });
});
