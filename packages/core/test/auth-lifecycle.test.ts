import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthToken, EndpointProfile } from "../src/index";
import type { OnboardingIo } from "../src/provider-onboarding";
import {
  isSubscriptionKind,
  providerLogin,
  providerLogout,
  providerStatus,
} from "../src/auth/lifecycle";

/** IO double: pre-scripted answers, recorded info lines. */
function ioWith(answers: string[]): OnboardingIo & { said: string[] } {
  const said: string[] = [];
  let i = 0;
  return {
    ask: async (prompt: string) => {
      said.push(prompt);
      return answers[i++] ?? "";
    },
    info: async (line: string) => {
      said.push(line);
    },
    openUrl: async () => false,
    said,
  };
}

const dirs: string[] = [];
function authFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-auth-lifecycle-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".moh"), { recursive: true });
  return join(dir, ".moh", "config");
}

const fakeToken = (over: Partial<AuthToken> = {}): AuthToken => ({
  accessToken: "acc-xyz",
  refreshToken: "ref-xyz",
  expiresAt: 1_800_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...over,
});

const endpoints = (): EndpointProfile[] => [
  { name: "anthropic", type: "anthropic", defaultModel: "claude-sonnet-4-5", auth: { kind: "subscription" } },
  { name: "openai", type: "openai", defaultModel: "gpt-5", apiKey: "sk-inline" },
  { name: "google", type: "google", defaultModel: "gemini-2.5-flash" },
];

describe("isSubscriptionKind", () => {
  test("only the three built-in grant providers qualify", () => {
    expect(isSubscriptionKind("anthropic")).toBe(true);
    expect(isSubscriptionKind("openai")).toBe(true);
    expect(isSubscriptionKind("google")).toBe(true);
    expect(isSubscriptionKind("openai-compat")).toBe(false);
    expect(isSubscriptionKind("mock")).toBe(false);
  });
});

describe("providerLogin", () => {
  test("runs the provider grant and stores tokens under the endpoint name", async () => {
    const file = authFile();
    const io = ioWith(["y"]); // ToS ack; grant scripted below
    const token = await providerLogin(endpoints()[0]!, io, {
      authFile: file,
      loginImpl: async () => fakeToken({ account: { email: "dev@example.test" } }),
    });
    expect(token.account?.email).toBe("dev@example.test");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.auth.tokens.anthropic.accessToken).toBe("acc-xyz");
  });

  test("re-login replaces the stored token set", async () => {
    const file = authFile();
    const ep = endpoints()[0]!;
    await providerLogin(ep, ioWith(["y"]), { authFile: file, loginImpl: async () => fakeToken() });
    await providerLogin(ep, ioWith(["y"]), {
      authFile: file,
      loginImpl: async () => fakeToken({ accessToken: "acc-new", refreshToken: undefined }),
    });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(saved.auth.tokens)).toEqual(["anthropic"]);
    expect(saved.auth.tokens.anthropic.accessToken).toBe("acc-new");
  });

  test("rejects kinds without a subscription grant", async () => {
    const file = authFile();
    const ep: EndpointProfile = { name: "ollama", type: "openai-compat", defaultModel: "qwen3" };
    await expect(
      providerLogin(ep, ioWith([]), { authFile: file, loginImpl: async () => fakeToken() }),
    ).rejects.toThrow("openai-compat");
  });
});

describe("providerLogout", () => {
  test("drops only the named endpoint's tokens; reports absence", async () => {
    const file = authFile();
    const eps = endpoints();
    await providerLogin(eps[0]!, ioWith(["y"]), { authFile: file, loginImpl: async () => fakeToken() });
    expect(providerLogout("google", { authFile: file })).toBe(false);
    expect(providerLogout("anthropic", { authFile: file })).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.auth.tokens).toEqual({});
  });
});

describe("providerStatus", () => {
  test("reports per-endpoint auth kind, credential source, expiry, plan; redacts secrets", async () => {
    const file = authFile();
    const eps = endpoints();
    await providerLogin(eps[0]!, ioWith(["y"]), { authFile: file, loginImpl: async () => fakeToken({ account: { email: "dev@example.test" } }) });
    const openaiEp: EndpointProfile = { name: "openai", type: "openai", defaultModel: "gpt-5", auth: { kind: "subscription" } };
    await providerLogin(openaiEp, ioWith(["y"]), {
      authFile: file,
      loginImpl: async () => fakeToken({ grant: { provider: "openai", plan: "chatgpt_pro" } }),
    });
    const rows = await providerStatus(eps, {
      authFile: file,
      env: { MOH_ENDPOINT_GOOGLE_API_KEY: "env-key" },
      usageFetch: async () => ({ status: 200, text: `{"usage":{"current":"12%"}}` }),
    });
    expect(rows).toHaveLength(3);
    const [a, o, g] = rows;
    expect(a).toMatchObject({
      name: "anthropic",
      type: "anthropic",
      authKind: "subscription",
      subscription: { loggedIn: true, account: "dev@example.test", expiresAt: 1_800_000_000_000 },
    });
    expect(a!.subscription!.usage).toContain("12%");
    expect(o).toMatchObject({ name: "openai", authKind: "api-key", apiKeySource: "inline" });
    expect(g).toMatchObject({ name: "google", authKind: "api-key", apiKeySource: "env" });
    // Redaction: no token or key material anywhere in the serialized rows.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("acc-xyz");
    expect(dump).not.toContain("ref-xyz");
    expect(dump).not.toContain("env-key");
    expect(dump).not.toContain("sk-inline");
  });

  test("subscription endpoint without tokens reports logged-out", async () => {
    const file = authFile();
    const rows = await providerStatus(endpoints().slice(0, 1), { authFile: file, usageFetch: async () => ({ status: 200, text: "{}" }) });
    expect(rows[0]!.subscription).toEqual({ loggedIn: false });
  });

  test("anthropic usage fetch is best-effort: failure degrades, never throws", async () => {
    const file = authFile();
    const eps = endpoints();
    await providerLogin(eps[0]!, ioWith(["y"]), { authFile: file, loginImpl: async () => fakeToken() });
    const rows = await providerStatus(eps.slice(0, 1), {
      authFile: file,
      usageFetch: async () => {
        throw new Error("network down");
      },
    });
    expect(rows[0]!.subscription!.usage).toContain("unavailable");
  });

  test("openai subscription shows the plan from grant metadata", async () => {
    const file = authFile();
    const ep: EndpointProfile = { name: "openai", type: "openai", defaultModel: "gpt-5", auth: { kind: "subscription" } };
    await providerLogin(ep, ioWith(["y"]), {
      authFile: file,
      loginImpl: async () => fakeToken({ grant: { provider: "openai", plan: "plus" } }),
    });
    const rows = await providerStatus([ep], { authFile: file });
    expect(rows[0]!.subscription).toMatchObject({ loggedIn: true, plan: "plus" });
  });
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
