import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMergedConfig,
  mergeProviderConfigs,
  readUserProviderConfig,
  upsertUserEndpoint,
  saveUserProviderRef,
  setUserEndpointModel,
  setUserEndpointFallbackEligible,
  type UserProviderConfig,
} from "../src/provider-config";
import { loadMohConfig, type MohConfig } from "../src/config";
import { userConfigFile } from "../src/user-config";

function tempDir(tag: string): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `moh-pc-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("readUserProviderConfig", () => {
  test("missing file reads as empty", () => {
    const { dir, cleanup } = tempDir("read-missing");
    try {
      expect(readUserProviderConfig(join(dir, "config"))).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("absent sections read as empty; unrelated keys preserved by the caller", () => {
    const { dir, cleanup } = tempDir("read-absent");
    try {
      const file = join(dir, "config");
      writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: {} }));
      expect(readUserProviderConfig(file)).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("valid provider/endpoints sections parse", () => {
    const { dir, cleanup } = tempDir("read-valid");
    try {
      const file = join(dir, "config");
      writeFileSync(
        file,
        JSON.stringify({
          provider: "anthropic-work/claude-sonnet-4-5",
          endpoints: [{ name: "anthropic-work", type: "anthropic", apiKey: "sk-user", defaultModel: "claude-sonnet-4-5" }],
        }),
      );
      const cfg = readUserProviderConfig(file);
      expect(cfg.provider).toBe("anthropic-work/claude-sonnet-4-5");
      expect(cfg.endpoints).toHaveLength(1);
      expect(cfg.endpoints![0]!.apiKey).toBe("sk-user");
    } finally {
      cleanup();
    }
  });

  test("invalid endpoints section throws with a clear error naming the file", () => {
    const { dir, cleanup } = tempDir("read-invalid");
    try {
      const file = join(dir, "config");
      writeFileSync(file, JSON.stringify({ endpoints: [{ name: "x", type: "anthropic" }] })); // missing defaultModel is fine... use bad type
      // actually make it invalid: endpoints not an array
      writeFileSync(file, JSON.stringify({ endpoints: { nope: true } }));
      expect(() => readUserProviderConfig(file)).toThrow(/config/);
      writeFileSync(file, JSON.stringify({ provider: 42 }));
      expect(() => readUserProviderConfig(file)).toThrow(/provider/);
    } finally {
      cleanup();
    }
  });

  test("corrupt JSON (whole file) reads as empty — display chrome tolerance lives at the guardian", () => {
    const { dir, cleanup } = tempDir("read-corrupt");
    try {
      const file = join(dir, "config");
      writeFileSync(file, "{ not json");
      // The guardian tolerates a corrupt file for chrome; the provider
      // layering must not hard-fail on garbage that isn't even sections.
      expect(readUserProviderConfig(file)).toEqual({});
    } finally {
      cleanup();
    }
  });
});

const userEndpoint = (): UserProviderConfig => ({
  endpoints: [{ name: "work", type: "anthropic", apiKey: "sk-user-key", defaultModel: "claude-sonnet-4-5" }],
});

describe("mergeProviderConfigs", () => {
  const project: MohConfig = {
    endpoints: [{ name: "work", type: "anthropic", defaultModel: "claude-opus-4" }],
  };

  test("per-field inheritance: project defaultModel wins, apiKey inherits from user", () => {
    const merged = mergeProviderConfigs(project, userEndpoint(), {});
    expect(merged.endpoints).toEqual([
      { name: "work", type: "anthropic", apiKey: "sk-user-key", defaultModel: "claude-opus-4" },
    ]);
  });

  test("user-only endpoints are appended after project endpoints", () => {
    const merged = mergeProviderConfigs(
      { endpoints: [{ name: "local", type: "openai-compat", baseUrl: "http://x/v1", defaultModel: "qwen3" }] },
      userEndpoint(),
      {},
    );
    expect(merged.endpoints!.map((e) => e.name)).toEqual(["local", "work"]);
  });

  test("env key beats both files (decision 3 precedence)", () => {
    const merged = mergeProviderConfigs(project, userEndpoint(), { MOH_ENDPOINT_WORK_API_KEY: "sk-env" });
    expect(merged.endpoints![0]!.apiKey).toBe("sk-env");
  });

  test("project inline key beats user key when env is unset", () => {
    const merged = mergeProviderConfigs(
      { endpoints: [{ name: "work", type: "anthropic", apiKey: "sk-project", defaultModel: "m" }] },
      userEndpoint(),
      {},
    );
    expect(merged.endpoints![0]!.apiKey).toBe("sk-project");
  });

  test("capabilities merge shallowly, project winning", () => {
    const merged = mergeProviderConfigs(
      { endpoints: [{ name: "work", type: "anthropic", defaultModel: "m", capabilities: { caching: true } }] },
      { endpoints: [{ name: "work", type: "anthropic", defaultModel: "m", capabilities: { caching: false, multimodal: false } }] },
      {},
    );
    expect(merged.endpoints![0]!.capabilities).toEqual({ caching: true, multimodal: false });
  });

  test("name collision with different identity fails loudly (#695): type differs", () => {
    expect(() =>
      mergeProviderConfigs(
        { endpoints: [{ name: "work", type: "openai-compat", baseUrl: "https://evil.example/v1" }] },
        userEndpoint(),
        {},
      ),
    ).toThrow(/endpoint name collision.*"work"/);
  });

  test("name collision with different identity fails loudly (#695): baseUrl differs", () => {
    expect(() =>
      mergeProviderConfigs(
        { endpoints: [{ name: "work", type: "anthropic", baseUrl: "https://evil.example/v1" }] },
        userEndpoint(),
        {},
      ),
    ).toThrow(/endpoint name collision/);
  });

  test("name collision with matching identity (type and baseUrl both unset) merges per-field", () => {
    const merged = mergeProviderConfigs(
      { endpoints: [{ name: "work", type: "anthropic", defaultModel: "claude-opus-4" }] },
      { endpoints: [{ name: "work", type: "anthropic", apiKey: "sk-user-key" }] },
      {},
    );
    expect(merged.endpoints).toEqual([{ name: "work", type: "anthropic", apiKey: "sk-user-key", defaultModel: "claude-opus-4" }]);
  });

  test("default provider reference: project > user; absent everywhere stays unset", () => {
    expect(mergeProviderConfigs({}, { provider: "u/m" }, {}).provider).toBe("u/m");
    expect(mergeProviderConfigs({ provider: "p/m" }, { provider: "u/m" }, {}).provider).toBe("p/m");
    expect(mergeProviderConfigs({}, {}, {}).provider).toBeUndefined();
  });
});

describe("loadMergedConfig", () => {
  test("no moh.json anywhere: user provider is available (AC 1)", () => {
    const { dir, cleanup } = tempDir("merged-user-only");
    try {
      const home = join(dir, "home");
      mkdirSync(join(home, ".moh"), { recursive: true });
      writeFileSync(
        join(home, ".moh", "config"),
        JSON.stringify({ provider: "work/claude-sonnet-4-5", endpoints: [{ name: "work", type: "mock", defaultModel: "demo" }] }),
      );
      const merged = loadMergedConfig(join(dir, "project"), { home });
      expect(merged.provider).toBe("work/claude-sonnet-4-5");
      expect(merged.endpoints).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("project moh.json layers over user config", () => {
    const { dir, cleanup } = tempDir("merged-both");
    try {
      const home = join(dir, "home");
      const cwd = join(dir, "project");
      mkdirSync(join(home, ".moh"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(home, ".moh", "config"),
        JSON.stringify({ endpoints: [{ name: "work", type: "anthropic", apiKey: "sk-user", defaultModel: "claude-sonnet-4-5" }] }),
      );
      writeFileSync(join(cwd, "moh.json"), JSON.stringify({ endpoints: [{ name: "work", type: "anthropic", defaultModel: "claude-opus-4" }] }));
      const merged = loadMergedConfig(cwd, { home });
      expect(merged.endpoints![0]).toEqual({
        name: "work",
        type: "anthropic",
        apiKey: "sk-user",
        defaultModel: "claude-opus-4",
      });
    } finally {
      cleanup();
    }
  });

  test("invalid user provider section throws", () => {
    const { dir, cleanup } = tempDir("merged-invalid");
    try {
      const home = join(dir, "home");
      mkdirSync(join(home, ".moh"), { recursive: true });
      writeFileSync(join(home, ".moh", "config"), JSON.stringify({ provider: 5 }));
      expect(() => loadMergedConfig(join(dir, "project"), { home })).toThrow(/provider/);
    } finally {
      cleanup();
    }
  });
});

describe("user-level writes (guardian)", () => {
  test("upsertUserEndpoint preserves unrelated keys and sections", () => {
    const { dir, cleanup } = tempDir("write-upsert");
    try {
      const file = userConfigFile(join(dir, "home"));
      mkdirSync(join(dir, "home", ".moh"), { recursive: true });
      writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { fetch: { type: "http", url: "https://x" } } }));
      upsertUserEndpoint(file, { name: "work", type: "anthropic", apiKey: "sk", defaultModel: "m" });
      const raw = JSON.parse(readFileSync(file, "utf8"));
      expect(raw.theme).toBe("dark");
      expect(raw.mcpServers).toBeDefined();
      expect(raw.endpoints).toEqual([{ name: "work", type: "anthropic", apiKey: "sk", defaultModel: "m" }]);
      // replace-by-name
      upsertUserEndpoint(file, { name: "work", type: "anthropic", defaultModel: "m2" });
      expect(JSON.parse(readFileSync(file, "utf8")).endpoints).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("saveUserProviderRef sets provider and preserves everything else", () => {
    const { dir, cleanup } = tempDir("write-ref");
    try {
      const file = userConfigFile(join(dir, "home"));
      mkdirSync(join(dir, "home", ".moh"), { recursive: true });
      writeFileSync(file, JSON.stringify({ theme: "dark" }));
      saveUserProviderRef(file, "work/m");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      expect(raw.provider).toBe("work/m");
      expect(raw.theme).toBe("dark");
    } finally {
      cleanup();
    }
  });

  test("setUserEndpointModel sets the preferred model of one endpoint, leaving the rest untouched", () => {
    const { dir, cleanup } = tempDir("write-pref");
    try {
      const file = userConfigFile(join(dir, "home"));
      mkdirSync(join(dir, "home", ".moh"), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          theme: "dark",
          provider: "a/m1",
          endpoints: [
            { name: "a", type: "anthropic", defaultModel: "m1", fallbackEligible: false },
            { name: "b", type: "openai", defaultModel: "m2" },
          ],
        }),
      );
      setUserEndpointModel(file, "b", "gpt-5.1");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      // The target changed…
      expect(raw.endpoints[1].defaultModel).toBe("gpt-5.1");
      // …the sibling kept every field, including the ones this never touches…
      expect(raw.endpoints[0]).toEqual({ name: "a", type: "anthropic", defaultModel: "m1", fallbackEligible: false });
      // …and unrelated keys/sections survive.
      expect(raw.theme).toBe("dark");
      expect(raw.provider).toBe("a/m1");
    } finally {
      cleanup();
    }
  });

  test("setUserEndpointModel(null) clears the field instead of writing an empty string", () => {
    const { dir, cleanup } = tempDir("write-pref-clear");
    try {
      const file = userConfigFile(join(dir, "home"));
      mkdirSync(join(dir, "home", ".moh"), { recursive: true });
      writeFileSync(file, JSON.stringify({ endpoints: [{ name: "a", type: "anthropic", defaultModel: "m1", apiKey: "sk" }] }));
      setUserEndpointModel(file, "a", null);
      const endpoint = JSON.parse(readFileSync(file, "utf8")).endpoints[0];
      // A cleared preferred model is an absent field, not `""` — the chain
      // builder tests `defaultModel !== undefined` for eligibility.
      expect("defaultModel" in endpoint).toBe(false);
      expect(endpoint.apiKey).toBe("sk");
    } finally {
      cleanup();
    }
  });

  test("setUserEndpointFallbackEligible(false) excludes one endpoint and leaves its siblings alone", () => {
    const { dir, cleanup } = tempDir("write-exclude");
    try {
      const file = userConfigFile(join(dir, "home"));
      mkdirSync(join(dir, "home", ".moh"), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          endpoints: [
            { name: "a", type: "anthropic", defaultModel: "m1" },
            { name: "b", type: "openai", defaultModel: "m2" },
          ],
        }),
      );
      setUserEndpointFallbackEligible(file, "b", false);
      const raw = JSON.parse(readFileSync(file, "utf8"));
      // The excluded one keeps its preferred model — excluding is orthogonal
      // to the model choice.
      expect(raw.endpoints[1]).toEqual({ name: "b", type: "openai", defaultModel: "m2", fallbackEligible: false });
      expect(raw.endpoints[0]).toEqual({ name: "a", type: "anthropic", defaultModel: "m1" });
    } finally {
      cleanup();
    }
  });

  test("setUserEndpointFallbackEligible(true) removes the flag instead of writing true", () => {
    const { dir, cleanup } = tempDir("write-include");
    try {
      const file = userConfigFile(join(dir, "home"));
      mkdirSync(join(dir, "home", ".moh"), { recursive: true });
      writeFileSync(file, JSON.stringify({ endpoints: [{ name: "a", type: "anthropic", fallbackEligible: false, apiKey: "sk" }] }));
      setUserEndpointFallbackEligible(file, "a", true);
      const endpoint = JSON.parse(readFileSync(file, "utf8")).endpoints[0];
      // Default is eligible, so the key is noise once it says so again.
      expect("fallbackEligible" in endpoint).toBe(false);
      expect(endpoint.apiKey).toBe("sk");
    } finally {
      cleanup();
    }
  });

  test("setUserEndpointFallbackEligible refuses an endpoint the user config does not declare", () => {
    const { dir, cleanup } = tempDir("write-exclude-missing");
    try {
      const file = userConfigFile(join(dir, "home"));
      mkdirSync(join(dir, "home", ".moh"), { recursive: true });
      writeFileSync(file, JSON.stringify({ endpoints: [{ name: "a", type: "anthropic" }] }));
      expect(() => setUserEndpointFallbackEligible(file, "ghost", false)).toThrow(/no user-level endpoint "ghost"/);
    } finally {
      cleanup();
    }
  });

  test("setUserEndpointModel refuses an endpoint the user config does not declare", () => {
    const { dir, cleanup } = tempDir("write-pref-missing");
    try {
      const file = userConfigFile(join(dir, "home"));
      mkdirSync(join(dir, "home", ".moh"), { recursive: true });
      writeFileSync(file, JSON.stringify({ endpoints: [{ name: "a", type: "anthropic" }] }));
      // Silently inventing a provider the user never configured would put an
      // endpoint with no credentials into the fallback chain.
      expect(() => setUserEndpointModel(file, "ghost", "m")).toThrow(/no user-level endpoint "ghost"/);
      const raw = JSON.parse(readFileSync(file, "utf8"));
      expect(raw.endpoints).toEqual([{ name: "a", type: "anthropic" }]);
    } finally {
      cleanup();
    }
  });
});

describe("review fixes (#129)", () => {
  test("env key beats the user file for user-only endpoints too (decision 3)", () => {
    const merged = mergeProviderConfigs({}, userEndpoint(), { MOH_ENDPOINT_WORK_API_KEY: "sk-env" });
    expect(merged.endpoints![0]!.apiKey).toBe("sk-env");
  });

  test("env unset: user-only endpoint keeps its inline key", () => {
    const merged = mergeProviderConfigs({}, userEndpoint(), {});
    expect(merged.endpoints![0]!.apiKey).toBe("sk-user-key");
  });
});
