import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMohConfig } from "@moh/core";
import { DEFAULT_MODELS, detectEnvProviders, saveDetectedProvider, saveWizardProvider } from "../src/onboarding";

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
