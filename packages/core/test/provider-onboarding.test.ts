import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { minimalConnectionTest, type ConnectionTester, type EndpointProfile } from "../src/index";
import {
  addProviderToFile,
  OnboardingAborted,
  runProviderAdd,
  type OnboardingIo,
} from "../src/provider-onboarding";

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
    said,
  };
}

const okTest = (): ConnectionTester => async () => ({ ok: true, modelId: "qwen3" });

const answers = (): string[] => ["openai-compat", "", "", "http://localhost:11434/v1", "qwen3"];

describe("runProviderAdd (guided flow)", () => {
  test("collects type, name, key, baseURL, default model; mandatory test passes", async () => {
    const io = ioWith(answers());
    const profile = await runProviderAdd(io, okTest());
    expect(profile).toEqual({
      name: "openai-compat",
      type: "openai-compat",
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "qwen3",
    });
    // no api key key when left empty (env var fallback applies)
    expect("apiKey" in profile).toBe(false);
  });

  test("aborts when the user declines to retry a failed connection test", async () => {
    const fail: ConnectionTester = async () => ({ ok: false, error: "HTTP 401" });
    const io = ioWith([...answers(), "n"]);
    await expect(runProviderAdd(io, fail)).rejects.toThrow(OnboardingAborted);
  });

  test("failed test offers edit-and-retry; fixed inputs pass", async () => {
    let calls = 0;
    const tester: ConnectionTester = async (profile) => {
      calls += 1;
      if (calls === 1) return { ok: false, error: "HTTP 404" };
      expect(profile?.baseUrl).toBe("http://localhost:12345/v1");
      expect(profile?.defaultModel).toBe("llama3.2");
      return { ok: true, modelId: profile.defaultModel! };
    };
    const io = ioWith([
      "openai-compat", "", "", "http://localhost:11434/v1", "qwen3",
      "y",                       // retry
      "http://localhost:12345/v1", // new baseUrl
      "llama3.2",                  // new model
    ]);
    const profile = await runProviderAdd(io, tester);
    expect(calls).toBe(2);
    expect(profile.baseUrl).toBe("http://localhost:12345/v1");
    expect(profile.defaultModel).toBe("llama3.2");
  });

  test("openai-compat without a base URL aborts; invalid type is re-asked", async () => {
    const io = ioWith(["openai-compat", "", "", ""]);
    await expect(runProviderAdd(io, okTest())).rejects.toThrow("base URL");
  });
});

describe("addProviderToFile", () => {
  test("persists the profile to moh.json and sets the default provider", async () => {
    const file = `${import.meta.dir}/tmp-onboarding/moh.json`;
    await Bun.write(file, JSON.stringify({ provider: "mock" }, null, 2));
    try {
      const io = ioWith(answers());
      const { config } = await addProviderToFile(io, file, { tester: okTest() });
      expect(config.provider).toBe("openai-compat/qwen3");
      const saved = JSON.parse(readFileSync(file, "utf8"));
      expect(saved.endpoints).toHaveLength(1);
      expect(saved.endpoints[0]).toEqual(config.endpoints![0]);
    } finally {
      await Bun.file(file).delete();
    }
  });

  test("upsert replaces an existing endpoint with the same name", async () => {
    const file = `${import.meta.dir}/tmp-onboarding/moh.json`;
    await Bun.write(
      file,
      JSON.stringify({
        provider: "ollama/qwen3",
        endpoints: [
          { name: "openai-compat", type: "openai-compat", baseUrl: "http://old", defaultModel: "old" },
          { name: "other", type: "openai-compat", baseUrl: "http://other", defaultModel: "m" },
        ],
      }),
    );
    try {
      const io = ioWith(answers());
      const { config } = await addProviderToFile(io, file, { tester: okTest() });
      expect(config.endpoints?.map((e) => e.name).sort()).toEqual(["openai-compat", "other"]);
      expect(config.endpoints!.find((e) => e.name === "openai-compat")!.baseUrl).toBe("http://localhost:11434/v1");
    } finally {
      await Bun.file(file).delete();
    }
  });
});

describe("minimalConnectionTest", () => {
  const profile: EndpointProfile = {
    name: "ollama",
    type: "openai-compat",
    baseUrl: "http://localhost:9/v1",
    apiKey: "k",
    defaultModel: "qwen3",
  };

  test("2xx passes; non-2xx surfaces status and body snippet", async () => {
    const ok = await minimalConnectionTest(profile, (async () => new Response("{}", { status: 200 })) as never as typeof fetch);
    expect(ok).toEqual({ ok: true, modelId: "qwen3" });
    const bad = await minimalConnectionTest(
      profile,
      (async () => new Response("invalid api key", { status: 401 })) as never as typeof fetch,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("401");
  });

  test("network failure surfaces the error message", async () => {
    const result = await minimalConnectionTest(
      { ...profile, baseUrl: "http://localhost:1/v1" },
      undefined as never as typeof fetch,
      AbortSignal.timeout(500),
    );
    expect(result.ok).toBe(false);
  });

  test("empty inline key falls back to MOH_ENDPOINT_<NAME>_API_KEY from env (#62)", async () => {
    let authHeader = "";
    const fetchSpy = (async (_url: unknown, init?: RequestInit) => {
      authHeader = String((init?.headers as Record<string, string>).authorization ?? "");
      return new Response("{}", { status: 200 });
    }) as never as typeof fetch;
    const result = await minimalConnectionTest(
      { name: "zai", type: "openai-compat", baseUrl: "http://localhost:9/v1", defaultModel: "glm-4.6" },
      fetchSpy,
      AbortSignal.timeout(500),
      { MOH_ENDPOINT_ZAI_API_KEY: "env-key-123" },
    );
    expect(result).toEqual({ ok: true, modelId: "glm-4.6" });
    expect(authHeader).toBe("Bearer env-key-123");
  });

  test("blank-string inline key (\"\") still falls back to the env key (#62)", async () => {
    let authHeader = "";
    const fetchSpy = (async (_url: unknown, init?: RequestInit) => {
      authHeader = String((init?.headers as Record<string, string>).authorization ?? "");
      return new Response("{}", { status: 200 });
    }) as never as typeof fetch;
    const result = await minimalConnectionTest(
      { name: "zai", type: "openai-compat", baseUrl: "http://localhost:9/v1", defaultModel: "glm-4.6", apiKey: "" },
      fetchSpy,
      AbortSignal.timeout(500),
      { MOH_ENDPOINT_ZAI_API_KEY: "env-key-123" },
    );
    expect(result).toEqual({ ok: true, modelId: "glm-4.6" });
    expect(authHeader).toBe("Bearer env-key-123");
  });

  test("no inline key and no env key: cloud providers fail fast with a clear error (#62)", async () => {
    const anthropic = await minimalConnectionTest(
      { name: "myanthropic", type: "anthropic", defaultModel: "claude-sonnet-4-5" },
      undefined as never as typeof fetch,
      AbortSignal.timeout(500),
      {},
    );
    expect(anthropic).toEqual({
      ok: false,
      error: "no api key configured: set an inline key or MOH_ENDPOINT_MYANTHROPIC_API_KEY",
    });
  });

  test("no inline key and no env key: openai-compat (local) still tests without auth (#62)", async () => {
    let authHeader = "sentinel";
    const fetchSpy = (async (_url: unknown, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>).authorization ?? "absent";
      return new Response("{}", { status: 200 });
    }) as never as typeof fetch;
    const result = await minimalConnectionTest(
      { name: "ollama", type: "openai-compat", baseUrl: "http://localhost:9/v1", defaultModel: "qwen3" },
      fetchSpy,
      AbortSignal.timeout(500),
      {},
    );
    expect(result.ok).toBe(true);
    expect(authHeader).toBe("absent");
  });
});

// --- Subscription branch (issue #138, spec decision 3) ---

const fakeToken = () => ({
  accessToken: "acc-xyz",
  refreshToken: "ref-xyz",
  updatedAt: 1_700_000_000_000,
});

describe("runProviderAdd (subscription branch)", () => {
  test("subscription choice skips the key prompt, logs in, marks auth kind, stores tokens", async () => {
    const authFile = `${import.meta.dir}/tmp-onboarding/config`;
    await Bun.write(authFile, "{}");
    const io = ioWith([
      "anthropic",       // type
      "",                // name default
      "subscription",    // auth method
      "",                // baseUrl default
      "claude-sonnet-4-5",
    ]);
    try {
      const profile = await runProviderAdd(io, okTest(), {
        authFile,
        subscriptionLogin: async () => fakeToken(),
      });
      expect(profile.auth).toEqual({ kind: "subscription" });
      expect("apiKey" in profile).toBe(false);
      // tokens live in the user config auth section, never in the profile
      const saved = JSON.parse(readFileSync(authFile, "utf8"));
      expect(saved.auth.tokens.anthropic.accessToken).toBe("acc-xyz");
    } finally {
      await Bun.file(authFile).delete();
    }
  });

  test("api-key choice keeps the byte-identical key prompt path", async () => {
    const io = ioWith([
      "anthropic",
      "",
      "api-key",
      "sk-live",
      "",
      "claude-sonnet-4-5",
    ]);
    const profile = await runProviderAdd(io, okTest());
    expect(profile.auth).toBeUndefined();
    expect(profile.apiKey).toBe("sk-live");
  });

  test("openai-compat never asks for an auth method (no subscription grant)", async () => {
    const io = ioWith(["openai-compat", "", "", "http://localhost:11434/v1", "qwen3"]);
    const profile = await runProviderAdd(io, okTest());
    expect(profile.auth).toBeUndefined();
    expect(io.said.join("\n")).not.toContain("Auth method");
  });

  test("declined ToS aborts the subscription branch", async () => {
    const io = ioWith(["anthropic", "", "subscription"]);
    await expect(
      runProviderAdd(io, okTest(), {
        subscriptionLogin: async () => { throw new Error("nope"); },
      }),
    ).rejects.toThrow("nope");
  });

  test("issue #150: endpoint stub persisted right after login — a post-login abort leaves a usable pair", async () => {
    const authFile = `${import.meta.dir}/tmp-onboarding/config-abort`;
    const configFile = `${import.meta.dir}/tmp-onboarding/moh-abort.json`;
    await Bun.write(authFile, "{}");
    await Bun.write(configFile, "{}");
    // Abort after login: no model given → OnboardingAborted.
    const io = ioWith(["google", "mygoogle", "subscription", "", ""]);
    try {
      await expect(
        runProviderAdd(io, okTest(), {
          authFile,
          configFile,
          subscriptionLogin: async () => fakeToken(),
        }),
      ).rejects.toBeInstanceOf(OnboardingAborted);
      // Tokens AND endpoint profile both survive the abort.
      const saved = JSON.parse(readFileSync(authFile, "utf8"));
      expect(saved.auth.tokens.mygoogle.accessToken).toBe("acc-xyz");
      const config = JSON.parse(readFileSync(configFile, "utf8"));
      expect(config.endpoints).toEqual([
        { name: "mygoogle", type: "google", auth: { kind: "subscription" } },
      ]);
    } finally {
      await Bun.file(authFile).delete();
      await Bun.file(configFile).delete();
    }
  });
});

describe("minimalConnectionTest (subscription)", () => {
  test("openai native grant (minted: false) pings the ChatGPT codex backend /responses with JWT + originator", async () => {
    const authFile = `${import.meta.dir}/tmp-onboarding/config`;
    await Bun.write(authFile, JSON.stringify({
      auth: {
        tokens: {
          codex: {
            accessToken: "jwt-abc",
            refreshToken: "ref-abc",
            updatedAt: 1_700_000_000_000,
            grant: { provider: "openai", minted: false },
          },
        },
      },
    }));
    const profile: EndpointProfile = {
      name: "codex",
      type: "openai",
      defaultModel: "gpt-5",
      auth: { kind: "subscription" },
    };
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await minimalConnectionTest(profile, fetchImpl, AbortSignal.timeout(1000), {}, authFile);
      expect(result.ok).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(calls[0]!.headers["authorization"]).toBe("Bearer jwt-abc");
      expect(calls[0]!.headers["originator"]).toBe("codex_cli_rs");
      expect((calls[0]!.body as Record<string, unknown>).input).toBe("ping");
    } finally {
      await Bun.file(authFile).delete();
    }
  });

  test("openai minted grant keeps the api.openai.com chat/completions path", async () => {
    const authFile = `${import.meta.dir}/tmp-onboarding/config`;
    await Bun.write(authFile, JSON.stringify({
      auth: {
        tokens: {
          openai: {
            accessToken: "sk-minted",
            refreshToken: "ref-abc",
            updatedAt: 1_700_000_000_000,
            grant: { provider: "openai", minted: true },
          },
        },
      },
    }));
    const profile: EndpointProfile = {
      name: "openai",
      type: "openai",
      defaultModel: "gpt-5",
      auth: { kind: "subscription" },
    };
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await minimalConnectionTest(profile, fetchImpl, AbortSignal.timeout(1000), {}, authFile);
      expect(result.ok).toBe(true);
      expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
      expect(calls[0]!.headers["authorization"]).toBe("Bearer sk-minted");
    } finally {
      await Bun.file(authFile).delete();
    }
  });

  test("google subscription sends the token as x-goog-api-key, matching the stream path", async () => {
    const authFile = `${import.meta.dir}/tmp-onboarding/config`;
    await Bun.write(authFile, JSON.stringify({ auth: { tokens: { gemini: fakeToken() } } }));
    const profile: EndpointProfile = {
      name: "gemini",
      type: "google",
      defaultModel: "gemini-2.5-pro",
      auth: { kind: "subscription" },
    };
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: Record<string, unknown>) => {
      calls.push(init);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await minimalConnectionTest(profile, fetchImpl, AbortSignal.timeout(1000), {}, authFile);
      expect(result.ok).toBe(true);
      const headers = calls[0]!.headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("acc-xyz");
      expect(headers["authorization"]).toBeUndefined();
    } finally {
      await Bun.file(authFile).delete();
    }
  });

  test("anthropic subscription uses the stored access token with the oauth beta header", async () => {
    const authFile = `${import.meta.dir}/tmp-onboarding/config`;
    await Bun.write(authFile, JSON.stringify({ auth: { tokens: { claude: fakeToken() } } }));
    const profile: EndpointProfile = {
      name: "claude",
      type: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      auth: { kind: "subscription" },
    };
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: Record<string, unknown>) => {
      calls.push(init);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await minimalConnectionTest(profile, fetchImpl, AbortSignal.timeout(1000), {}, authFile);
      expect(result.ok).toBe(true);
      const headers = calls[0]!.headers as Record<string, string>;
      expect(headers["authorization"]).toBe("Bearer acc-xyz");
      expect(headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
      expect(headers["x-api-key"]).toBeUndefined();
    } finally {
      await Bun.file(authFile).delete();
    }
  });

  test("subscription endpoint without stored tokens fails fast, no request sent", async () => {
    const authFile = `${import.meta.dir}/tmp-onboarding/config`;
    await Bun.write(authFile, "{}");
    const profile: EndpointProfile = {
      name: "claude",
      type: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      auth: { kind: "subscription" },
    };
    let sent = 0;
    const fetchImpl = (async () => {
      sent += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await minimalConnectionTest(profile, fetchImpl, AbortSignal.timeout(1000), {}, authFile);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("moh provider login");
      expect(sent).toBe(0);
    } finally {
      await Bun.file(authFile).delete();
    }
  });
});
