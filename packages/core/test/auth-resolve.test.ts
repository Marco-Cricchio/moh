import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEndpointCredential } from "../src/auth/resolve";
import { Endpoint, createRoute } from "../src/route";
import { ProviderError } from "../src/types";
import { MockProvider } from "../src/index";
import type { AuthToken } from "../src/auth/types";
import type { RouteTarget } from "../src/route";
import type { Message } from "../src/types";

const NOW = 1_700_000_000_000;
const WINDOW = 5 * 60 * 1000;

function tempConfig(initial?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-auth-resolve-"));
  const file = join(dir, "config");
  writeFileSync(file, JSON.stringify(initial ?? {}), "utf8");
  return file;
}

function subscriptionEndpoint(name: string): Endpoint {
  return new Endpoint({ name, kind: "anthropic", auth: { kind: "subscription" } });
}

function stored(overrides: Partial<AuthToken>): AuthToken {
  return { accessToken: "at-old", refreshToken: "rt-old", updatedAt: NOW - 1000, ...overrides };
}

/** Token-endpoint seam: scripted results in order, records bodies. */
function fetchScript(results: Array<{ status: number; json: Record<string, unknown> }>) {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const fn = async (_url: string, body: Record<string, unknown>) => {
    calls.push(body);
    return results[i++] ?? { status: 500, json: {} };
  };
  return Object.assign(fn, { calls });
}

describe("resolveEndpointCredential", () => {
  test("api-key endpoints: inline key returned, auth store untouched", async () => {
    const ep = new Endpoint({ name: "ep", kind: "anthropic", apiKey: "inline" });
    const cred = await resolveEndpointCredential({ endpoint: ep, modelId: "m" }, { configFile: "/nonexistent" });
    expect(cred).toBe("inline");
  });

  test("subscription with unexpired token: no refresh, no fetch", async () => {
    const file = tempConfig({ auth: { tokens: { "anthropic-work": stored({ accessToken: "at-fresh", expiresAt: NOW + 3600_000 }) } } });
    const fetch = fetchScript([]);
    const cred = await resolveEndpointCredential(
      { endpoint: subscriptionEndpoint("anthropic-work"), modelId: "m" },
      { configFile: file, now: NOW, fetchImpl: fetch },
    );
    expect(cred).toBe("at-fresh");
    expect(fetch.calls).toHaveLength(0);
  });

  test("token near expiry: refresh before use, rotated token persisted", async () => {
    const file = tempConfig({ auth: { tokens: { "anthropic-work": stored({ expiresAt: NOW + 60_000 }) } } });
    const fetch = fetchScript([
      { status: 200, json: { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600, scope: "user:inference" } },
    ]);
    const cred = await resolveEndpointCredential(
      { endpoint: subscriptionEndpoint("anthropic-work"), modelId: "m" },
      { configFile: file, now: NOW, fetchImpl: fetch },
    );
    expect(cred).toBe("at-new");
    expect(fetch.calls[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-old" });
    const saved = JSON.parse(readFileSync(file, "utf8")).auth.tokens["anthropic-work"];
    expect(saved.accessToken).toBe("at-new");
    expect(saved.refreshToken).toBe("rt-new");
  });

  test("unknown expiry: used as-is (no expiresAt, no oauthExpiresAt)", async () => {
    const file = tempConfig({ auth: { tokens: { "anthropic-work": stored({ accessToken: "at-noexp" }) } } });
    const fetch = fetchScript([]);
    const cred = await resolveEndpointCredential(
      { endpoint: subscriptionEndpoint("anthropic-work"), modelId: "m" },
      { configFile: file, now: NOW, fetchImpl: fetch },
    );
    expect(cred).toBe("at-noexp");
    expect(fetch.calls).toHaveLength(0);
  });

  test("openai minted keys refresh on oauthExpiresAt window", async () => {
    const file = tempConfig({
      auth: { tokens: { "openai-work": stored({ accessToken: "sk-minted-old", grant: { provider: "openai", minted: true, oauthExpiresAt: NOW + 60_000 } }) } },
    });
    // refresh grant then the RFC 8693 exchange (both hit the seam)
    const fetch = fetchScript([
      { status: 200, json: { access_token: "at-oauth", refresh_token: "rt-new", id_token: "x.y.z", expires_in: 3600 } },
      { status: 200, json: { access_token: "sk-minted-new" } },
    ]);
    const ep = new Endpoint({ name: "openai-work", kind: "openai", auth: { kind: "subscription" } });
    const cred = await resolveEndpointCredential({ endpoint: ep, modelId: "m" }, { configFile: file, now: NOW, fetchImpl: fetch });
    expect(cred).toBe("sk-minted-new");
    expect(fetch.calls[1]).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange" });
    const saved = JSON.parse(readFileSync(file, "utf8")).auth.tokens["openai-work"];
    expect(saved.accessToken).toBe("sk-minted-new");
  });

  test("#151: openai native grant (minted:false) resolves to the ChatGPT backend transport", async () => {
    const file = tempConfig({
      auth: { tokens: { "openai-work": stored({ accessToken: "oauth-at", grant: { provider: "openai", minted: false, oauthExpiresAt: NOW + 3600_000 } }) } },
    });
    const ep = new Endpoint({ name: "openai-work", kind: "openai", auth: { kind: "subscription" } });
    const resolved = await resolveEndpointCredential({ endpoint: ep, modelId: "m" }, { configFile: file, now: NOW });
    expect(resolved).toEqual({
      credential: "oauth-at",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      headers: { originator: "codex_cli_rs" },
      wire: "openai-responses",
    });
  });

  test("#151: openai minted grant keeps the plain api-key path (string credential)", async () => {
    const file = tempConfig({
      auth: { tokens: { "openai-work": stored({ accessToken: "sk-minted", grant: { provider: "openai", minted: true, oauthExpiresAt: NOW + 3600_000 } }) } },
    });
    const ep = new Endpoint({ name: "openai-work", kind: "openai", auth: { kind: "subscription" } });
    const resolved = await resolveEndpointCredential({ endpoint: ep, modelId: "m" }, { configFile: file, now: NOW });
    expect(resolved).toBe("sk-minted");
  });

  test("#151: refreshed native grant persists and resolves to the ChatGPT backend", async () => {
    const file = tempConfig({
      auth: { tokens: { "openai-work": stored({ accessToken: "oauth-at-old", grant: { provider: "openai", minted: false, idToken: "x.y.z", oauthExpiresAt: NOW + 60_000 } }) } },
    });
    // refresh grant succeeds, re-mint fails (non-fatal for native grants)
    const fetch = fetchScript([
      { status: 200, json: { access_token: "at-oauth-new", refresh_token: "rt-new", id_token: "x.y.z", expires_in: 3600 } },
      { status: 401, json: { error: { code: "invalid_subject_token" } } },
    ]);
    const ep = new Endpoint({ name: "openai-work", kind: "openai", auth: { kind: "subscription" } });
    const resolved = await resolveEndpointCredential({ endpoint: ep, modelId: "m" }, { configFile: file, now: NOW, fetchImpl: fetch });
    expect(resolved).toEqual({
      credential: "at-oauth-new",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      headers: { originator: "codex_cli_rs" },
      wire: "openai-responses",
    });
    const saved = JSON.parse(readFileSync(file, "utf8")).auth.tokens["openai-work"];
    expect(saved).toMatchObject({ accessToken: "at-oauth-new", grant: { minted: false } });
  });

  test("no stored tokens: ProviderError(auth) with login hint", async () => {
    const file = tempConfig();
    try {
      await resolveEndpointCredential({ endpoint: subscriptionEndpoint("anthropic-work"), modelId: "m" }, { configFile: file, now: NOW });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("auth");
      expect((err as Error).message).toContain("moh provider login anthropic-work");
    }
  });

  test("refresh failure: ProviderError(auth) with login hint, stale token untouched", async () => {
    const file = tempConfig({ auth: { tokens: { "anthropic-work": stored({ expiresAt: NOW + 60_000 }) } } });
    const fetch = fetchScript([{ status: 400, json: { error: "invalid_grant" } }]);
    try {
      await resolveEndpointCredential({ endpoint: subscriptionEndpoint("anthropic-work"), modelId: "m" }, { configFile: file, now: NOW, fetchImpl: fetch });
      expect.unreachable();
    } catch (err) {
      expect((err as ProviderError).kind).toBe("auth");
      expect((err as Error).message).toContain("moh provider login anthropic-work");
    }
    expect(JSON.parse(readFileSync(file, "utf8")).auth.tokens["anthropic-work"].accessToken).toBe("at-old");
  });
});

describe("route wiring (refresh-before-stream)", () => {
  const msgs: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];

  test("credential resolver runs once per subscription target; token reaches the stream factory", async () => {
    const resolved: string[] = [];
    const seen: (string | undefined)[] = [];
    const target: RouteTarget = { endpoint: subscriptionEndpoint("anthropic-work"), modelId: "m" };
    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const route = createRoute({
      target,
      credentialResolver: async (t) => {
        resolved.push(t.endpoint.name);
        return "at-resolved";
      },
      createStream: (t, credential) => {
        seen.push(credential);
        return (m, s) => provider.stream(m, s);
      },
    });
    for await (const _ of route.stream(msgs, new AbortController().signal));
    expect(resolved).toEqual(["anthropic-work"]);
    expect(seen).toEqual(["at-resolved"]);
  });

  test("#151: auth context (ChatGPT backend transport) reaches custom stream factories", async () => {
    const seenCtx: (unknown | undefined)[] = [];
    const target: RouteTarget = { endpoint: subscriptionEndpoint("openai-work"), modelId: "m" };
    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const route = createRoute({
      target,
      credentialResolver: async () => ({
        credential: "oauth-at",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        headers: { originator: "codex_cli_rs" },
        wire: "openai-responses" as const,
      }),
      createStream: (_t, _c, authContext) => {
        seenCtx.push(authContext);
        return (m, s) => provider.stream(m, s);
      },
    });
    for await (const _ of route.stream(msgs, new AbortController().signal));
    expect(seenCtx).toEqual([
      { credential: "oauth-at", baseUrl: "https://chatgpt.com/backend-api/codex", headers: { originator: "codex_cli_rs" }, wire: "openai-responses" },
    ]);
  });

  test("api-key targets skip the resolver entirely", async () => {
    const resolved: string[] = [];
    const ep = new Endpoint({ name: "plain", kind: "mock" });
    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const route = createRoute({
      target: { endpoint: ep, modelId: "m" },
      credentialResolver: async (t) => {
        resolved.push(t.endpoint.name);
        return "should-not-happen";
      },
      createStream: () => (m, s) => provider.stream(m, s),
    });
    for await (const _ of route.stream(msgs, new AbortController().signal));
    expect(resolved).toHaveLength(0);
  });

  test("resolver auth error surfaces as ProviderError(auth) from stream()", async () => {
    const target: RouteTarget = { endpoint: subscriptionEndpoint("anthropic-work"), modelId: "m" };
    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const route = createRoute({
      target,
      credentialResolver: async () => {
        throw new ProviderError("auth", "no subscription credentials; run `moh provider login anthropic-work`");
      },
      createStream: () => (m, s) => provider.stream(m, s),
    });
    try {
      for await (const _ of route.stream(msgs, new AbortController().signal));
      expect.unreachable();
    } catch (err) {
      expect((err as ProviderError).kind).toBe("auth");
    }
  });
});
