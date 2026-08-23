import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMohConfig, type EndpointProfile } from "@moh/core";
import { DEFAULT_MODELS, detectEnvProviders, saveDetectedProvider, saveWizardProvider, saveWizardProviderUser, wizardSavePlan } from "../src/onboarding";

const emptyEnv: Record<string, string | undefined> = {};

describe("detectEnvProviders", () => {
  test("nothing found with an empty environment", () => {
    expect(detectEnvProviders(emptyEnv)).toEqual([]);
  });

  test("detects each well-known var, one candidate per provider", () => {
    expect(detectEnvProviders({ ...emptyEnv, ANTHROPIC_API_KEY: "sk-1" })).toEqual([
      { type: "anthropic", envVar: "ANTHROPIC_API_KEY", defaultModel: DEFAULT_MODELS.anthropic },
    ]);
    expect(detectEnvProviders({ ...emptyEnv, OPENAI_API_KEY: "sk-2" })[0]!.type).toBe("openai");
    const google = detectEnvProviders({ ...emptyEnv, GEMINI_API_KEY: "k", GOOGLE_API_KEY: "k2" });
    expect(google).toHaveLength(1);
    expect(google[0]!.envVar).toBe("GEMINI_API_KEY"); // first wins
  });

  test("blank keys are ignored", () => {
    expect(detectEnvProviders({ ...emptyEnv, ANTHROPIC_API_KEY: "  " })).toEqual([]);
  });
});

describe("saveDetectedProvider", () => {
  test("writes an env-backed endpoint + default provider, no inline key", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-ob-"));
    const file = join(dir, "moh.json");
    writeFileSync(file, "{}\n");
    const candidate = { type: "anthropic" as const, envVar: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-5" };

    const config = saveDetectedProvider(file, candidate);

    expect(config.provider).toBe("anthropic/claude-sonnet-4-5");
    const onDisk = loadMohConfig(file);
    expect(onDisk.endpoints).toEqual([{ name: "anthropic", type: "anthropic", defaultModel: "claude-sonnet-4-5" }]);
    expect(onDisk.endpoints![0]!.apiKey).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain("anthropic");
  });
});

describe("saveWizardProvider", () => {
  test("persists a full profile (openai-compat with baseUrl + key)", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-ob-"));
    const file = join(dir, "moh.json");
    const config = saveWizardProvider(file, {
      name: "ollama",
      type: "openai-compat",
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "qwen3",
    });
    expect(config.provider).toBe("ollama/qwen3");
    expect(loadMohConfig(file).endpoints).toHaveLength(1);
  });
});

describe("wizardSavePlan (#129 decision 7)", () => {
  const profile: EndpointProfile = {
    name: "work",
    type: "anthropic",
    apiKey: "sk-1",
    defaultModel: "claude-sonnet-4-5",
  };

  test("brand-new endpoint: default scope is user on absolute first run", () => {
    expect(wizardSavePlan(profile, [], false)).toEqual({ kind: "new", defaultScope: "user" });
  });

  test("brand-new endpoint: default scope is project when a moh.json exists", () => {
    expect(wizardSavePlan(profile, [], true)).toEqual({ kind: "new", defaultScope: "project" });
  });

  test("same name + same config in user config: silent reuse", () => {
    expect(wizardSavePlan(profile, [profile], false)).toEqual({ kind: "reuse", existing: profile });
  });

  test("same name + different apiKey: key-conflict warning", () => {
    const existing = { ...profile, apiKey: "sk-other" };
    expect(wizardSavePlan(profile, [existing], false)).toEqual({ kind: "key-conflict", existing });
  });

  test("same name + different model (same key): still a conflict, not silent reuse", () => {
    const existing = { ...profile, defaultModel: "claude-opus-4" };
    expect(wizardSavePlan(profile, [existing], false)).toEqual({ kind: "key-conflict", existing });
  });

  test("different name but content match (type+baseUrl+defaultModel, key excluded): duplicate", () => {
    const existing = { ...profile, name: "other", apiKey: "sk-whatever" };
    expect(wizardSavePlan(profile, [existing], false)).toEqual({ kind: "duplicate", existing });
  });
});

describe("saveWizardProviderUser (#129)", () => {
  test("writes endpoint + default provider ref user-level through the guardian", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-ob-user-"));
    const file = join(dir, ".moh", "config");
    mkdirSync(join(dir, ".moh"), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "dark" }));

    const ref = saveWizardProviderUser(file, {
      name: "ollama",
      type: "openai-compat",
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "qwen3",
    });

    expect(ref).toBe("ollama/qwen3");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.theme).toBe("dark"); // guardian preservation
    expect(raw.provider).toBe("ollama/qwen3");
    expect(raw.endpoints).toEqual([
      { name: "ollama", type: "openai-compat", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen3" },
    ]);
  });
});
