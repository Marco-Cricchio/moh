import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  THINKING_LEVELS,
  defaultThinkingLevel,
  effectiveThinkingLevel,
  endpointThinkingStatus,
  resolveEndpointThinking,
  thinkingStatesForRef,
  type ThinkingLevelState,
} from "../src/thinking-preferences";
import type { ThinkingLevel } from "../src/types";
import { catalogEntryFor, normalizeThinkingLevelMap } from "../src/model-catalog";
import { readUserConfigFile, updateUserConfigFile } from "../src/user-config";
import type { EndpointProfile } from "../src/config";

type ThinkingCap = NonNullable<EndpointProfile["capabilities"]>["thinking"];

function tmpConfigFile(): string {
  return join(mkdtempSync(join(tmpdir(), "moh-thinking-256-")), "config");
}

/** openai-compat-style endpoint profile with a declared capability. */
function compatProfile(name: string, thinking?: ThinkingCap): EndpointProfile {
  return { name, type: "openai-compat", baseUrl: "https://example.test/v1", ...(thinking ? { capabilities: { thinking } } : {}) };
}

describe("#256 catalog `minimal` normalization", () => {
  test("a minimal-only map exposes canonical low with the native value", () => {
    expect(normalizeThinkingLevelMap({ minimal: "MINIMAL", off: null })).toEqual({ off: null, low: "MINIMAL" });
    // Real catalog fixture: openai-codex maps minimal→"low" with no low key.
    const entry = catalogEntryFor("openai", "gpt-5.4");
    expect(entry!.thinkingLevelMap!.low).toBe("low");
    expect("minimal" in entry!.thinkingLevelMap!).toBe(false);
  });

  test("when both minimal and low are present, low wins and minimal is dropped", () => {
    // gemma-4-26b carries minimal:"MINIMAL" AND low:null (explicit disable).
    const gemma = catalogEntryFor("google", "gemma-4-26b-a4b-it");
    expect(gemma!.thinkingLevelMap!.low).toBe(null);
    expect("minimal" in gemma!.thinkingLevelMap!).toBe(false);
    // github-copilot gpt-5.6-luna has minimal:"low" and low:"low".
    const entry = catalogEntryFor("github-copilot", "gpt-5.6-luna");
    expect(entry!.thinkingLevelMap!.low).toBe("low");
    expect("minimal" in entry!.thinkingLevelMap!).toBe(false);
  });
});

describe("#256 thinkingStatesForRef resolution chain", () => {
  const luna = "openrouter/openai/gpt-5.6-luna";

  test("catalog map with no config declaration (unchanged behavior)", () => {
    const endpoints = [{ name: "openrouter", type: "openrouter" }];
    const states = thinkingStatesForRef(luna, endpoints);
    expect(states?.xhigh).toBe("supported");
    expect(states?.low).toBe("provider-default");
  });

  test("endpoint-level declaration supplies capability where no catalog exists", () => {
    const endpoints = [compatProfile("local", { format: "openai-effort", levels: ["off", "low", "medium", "high"] })];
    const states = thinkingStatesForRef("local/qwen3", endpoints);
    expect(states?.low).toBe("supported");
    expect(states?.medium).toBe("supported");
    expect(states?.xhigh).toBe("provider-default");
    expect(states?.max).toBe("provider-default");
  });

  test("google-thinking-level cannot express xhigh/max even when declared", () => {
    const endpoints = [compatProfile("g", { format: "google-thinking-level", levels: THINKING_LEVELS as ThinkingLevel[] })];
    const states = thinkingStatesForRef("g/gemini", endpoints);
    expect(states?.low).toBe("supported");
    expect(states?.xhigh).toBe("provider-default");
    expect(states?.max).toBe("provider-default");
  });

  test("per-model declaration overrides the endpoint-level one and the catalog", () => {
    const endpoints: EndpointProfile[] = [
      {
        name: "openrouter",
        type: "openrouter",
        capabilities: {
          thinking: { format: "openai-effort", levels: ["low"] },
          thinkingModels: { "openai/gpt-5.6-luna": { levels: ["high", "xhigh"] } },
        },
      },
    ];
    const states = thinkingStatesForRef(luna, endpoints);
    expect(states?.low).toBe("provider-default"); // catalog overridden
    expect(states?.high).toBe("supported");
    expect(states?.xhigh).toBe("supported");
  });

  test("unknown endpoint or bare ref resolves to undefined", () => {
    expect(thinkingStatesForRef("nope/model", [{ name: "other", type: "openai" }])).toBeUndefined();
    expect(thinkingStatesForRef("mock", [])).toBeUndefined();
  });

  test("a per-model entry with no resolvable format is inert (catalog governs)", () => {
    const endpoints: EndpointProfile[] = [
      {
        name: "openrouter",
        type: "openrouter",
        capabilities: { thinkingModels: { "openai/gpt-5.6-luna": { levels: ["low"] } } },
      },
    ];
    // No own format, no endpoint-level declaration → falls through to the
    // vendored map (xhigh/max), not the unusable declared levels.
    const states = thinkingStatesForRef(luna, endpoints);
    expect(states?.xhigh).toBe("supported");
    expect(states?.low).toBe("provider-default");
  });
});

describe("#256 resolveEndpointThinking with declared capability", () => {
  test("openai-compat with declared medium defaults to medium (medium-if-supported)", () => {
    const file = tmpConfigFile();
    const endpoints = [compatProfile("local", { format: "openai-effort", levels: ["off", "low", "medium", "high"] })];
    expect(resolveEndpointThinking("local/qwen3", endpoints, file)).toEqual({ level: "medium" });
  });

  test("openai-compat without declaration stays conservative (nothing sent)", () => {
    const file = tmpConfigFile();
    updateUserConfigFile(file, (d) => { d.thinkingLevels = { local: "high" }; });
    const endpoints = [compatProfile("local")];
    expect(resolveEndpointThinking("local/qwen3", endpoints, file)).toBeUndefined();
  });

  test("declared preference is honored; undeclared level falls to default", () => {
    const file = tmpConfigFile();
    updateUserConfigFile(file, (d) => { d.thinkingLevels = { local: "high" }; });
    const endpoints = [compatProfile("local", { format: "openai-effort", levels: ["off", "low", "high"] })];
    expect(resolveEndpointThinking("local/qwen3", endpoints, file)).toEqual({ level: "high" });
    updateUserConfigFile(file, (d) => { d.thinkingLevels = { local: "xhigh" }; });
    // xhigh not declared → no remap, provider default (no medium declared either).
    expect(resolveEndpointThinking("local/qwen3", endpoints, file)).toBeUndefined();
  });
});

describe("#256 endpointThinkingStatus visibility", () => {
  test("unsupported persisted preference is reported, never dropped", () => {
    const file = tmpConfigFile();
    updateUserConfigFile(file, (d) => { d.thinkingLevels = { local: "xhigh" }; });
    const endpoints = [compatProfile("local", { format: "openai-effort", levels: ["low", "medium"] })];
    const status = endpointThinkingStatus("local/qwen3", endpoints, file);
    expect(status.level).toBeUndefined(); // provider default
    expect(status.unsupported).toBe("xhigh");
  });

  test("supported preference reports the level and no unsupported marker", () => {
    const file = tmpConfigFile();
    updateUserConfigFile(file, (d) => { d.thinkingLevels = { local: "medium" }; });
    const endpoints = [compatProfile("local", { format: "openai-effort", levels: ["low", "medium"] })];
    expect(endpointThinkingStatus("local/qwen3", endpoints, file)).toEqual({ level: "medium", unsupported: undefined });
  });

  test("no preference → default level, no marker", () => {
    const file = tmpConfigFile();
    const endpoints = [compatProfile("local", { format: "openai-effort", levels: ["low", "medium"] })];
    expect(endpointThinkingStatus("local/qwen3", endpoints, file)).toEqual({ level: "medium", unsupported: undefined });
  });
});
