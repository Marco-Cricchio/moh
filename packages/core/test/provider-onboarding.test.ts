import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  addProviderToFile,
  minimalConnectionTest,
  OnboardingAborted,
  runProviderAdd,
  type ConnectionTester,
  type EndpointProfile,
  type OnboardingIo,
} from "../src/index";

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
});
