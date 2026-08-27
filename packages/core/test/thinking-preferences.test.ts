import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearThinkingPreference,
  defaultThinkingLevel,
  effectiveThinkingLevel,
  readThinkingPreference,
  setThinkingPreference,
  THINKING_LEVELS,
  thinkingLevelStates,
} from "../src/thinking-preferences";
import { catalogEntryFor, subscriptionModelCatalog } from "../src/model-catalog";
import { readUserConfigFile } from "../src/user-config";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "moh-thinking-")), "config");
}

describe("catalog thinkingLevelMap (#241)", () => {
  test("the vendored catalog preserves thinkingLevelMap verbatim", () => {
    // anthropic ships entries with explicit off/xhigh/max mappings.
    const fable = catalogEntryFor("anthropic", "claude-fable-5");
    expect(fable?.thinkingLevelMap).toEqual({ off: null, xhigh: "xhigh", max: "max" });
    // non-canonical provider keys (e.g. "minimal") survive the seam too.
    const minimalPreserved = ["openai", "google", "github-copilot", "openrouter", "kimi-coding", "xai"].some((type) =>
      subscriptionModelCatalog(type).some(
        (m) => m.thinkingLevelMap && "minimal" in m.thinkingLevelMap,
      ),
    );
    expect(minimalPreserved).toBe(true);
  });

  test("entries without a map stay without one (reasoning flag is not a map)", () => {
    expect(catalogEntryFor("anthropic", "claude-haiku-4-5")?.thinkingLevelMap).toBeUndefined();
    expect(catalogEntryFor("anthropic", "claude-haiku-4-5")?.reasoning).toBe(true);
  });
});

describe("thinkingLevelStates (#241)", () => {
  test("distinguishes supported, disabled and provider-default levels", () => {
    const fable = catalogEntryFor("anthropic", "claude-fable-5")!;
    const states = thinkingLevelStates(fable)!;
    expect(states.off).toBe("disabled"); // explicit provider-native disable
    expect(states.xhigh).toBe("supported");
    expect(states.max).toBe("supported");
    expect(states.low).toBe("provider-default"); // absent key: not selectable
    expect(states.medium).toBe("provider-default");
  });

  test("covers every canonical level", () => {
    const states = thinkingLevelStates(catalogEntryFor("anthropic", "claude-fable-5")!)!
    expect(Object.keys(states).sort()).toEqual([...THINKING_LEVELS].sort());
  });

  test("no map (or no entry) means level selection is not offered at all", () => {
    expect(thinkingLevelStates(catalogEntryFor("anthropic", "claude-haiku-4-5"))).toBeUndefined();
    expect(thinkingLevelStates(undefined)).toBeUndefined();
  });
});

describe("defaultThinkingLevel (#241)", () => {
  test("a model supporting medium defaults to medium", () => {
    const withMedium = { id: "m", name: "m", contextWindow: 1, reasoning: true, thinkingLevelMap: { medium: "medium", high: "high" } };
    expect(defaultThinkingLevel(withMedium)).toBe("medium");
  });

  test("medium unsupported → provider default (no silent remap)", () => {
    const fable = catalogEntryFor("anthropic", "claude-fable-5")!;
    expect(defaultThinkingLevel(fable)).toBeUndefined();
  });

  test("no map → provider default", () => {
    expect(defaultThinkingLevel(catalogEntryFor("anthropic", "claude-haiku-4-5"))).toBeUndefined();
    expect(defaultThinkingLevel(undefined)).toBeUndefined();
  });
});

describe("effectiveThinkingLevel (#241: switches/fallback resolve per call)", () => {
  const wide = { id: "m", name: "m", contextWindow: 1, reasoning: true, thinkingLevelMap: { off: null, medium: "medium", high: "high" } };

  test("supported preference is sent as-is", () => {
    expect(effectiveThinkingLevel(wide, "high")).toBe("high");
  });

  test("disabled-state preference (explicit off) is sent as-is", () => {
    expect(effectiveThinkingLevel(wide, "off")).toBe("off");
  });

  test("unsupported preference is never remapped — falls to provider default", () => {
    expect(effectiveThinkingLevel(wide, "max")).toBeUndefined();
  });

  test("no preference: model default (medium when supported, else provider default)", () => {
    expect(effectiveThinkingLevel(wide, undefined)).toBe("medium");
    const fable = catalogEntryFor("anthropic", "claude-fable-5")!;
    expect(effectiveThinkingLevel(fable, undefined)).toBeUndefined();
  });

  test("model without a map always gets provider default", () => {
    expect(effectiveThinkingLevel(undefined, "high")).toBeUndefined();
    const haiku = catalogEntryFor("anthropic", "claude-haiku-4-5")!;
    expect(effectiveThinkingLevel(haiku, "medium")).toBeUndefined();
  });
});

describe("endpoint preferences in ~/.moh/config (#241)", () => {
  test("set then read round-trips, keyed by endpoint", () => {
    const file = tmpFile();
    setThinkingPreference(file, "my-anthropic", "xhigh");
    expect(readThinkingPreference(file, "my-anthropic")).toBe("xhigh");
  });

  test("endpoints are independent", () => {
    const file = tmpFile();
    setThinkingPreference(file, "a", "low");
    setThinkingPreference(file, "b", "max");
    expect(readThinkingPreference(file, "a")).toBe("low");
    expect(readThinkingPreference(file, "b")).toBe("max");
  });

  test("writing preserves unrelated user config (guardian-owned)", () => {
    const file = tmpFile();
    setThinkingPreference(file, "a", "low");
    setThinkingPreference(file, "keep-out", "off");
    const data = readUserConfigFile(file);
    expect(data.thinkingLevels).toEqual({ a: "low", "keep-out": "off" });
  });

  test("an invalid stored value reads as absent, never throws a session", () => {
    const read = () => JSON.stringify({ thinkingLevels: { a: "ultra" } });
    expect(readThinkingPreference("x", "a", read)).toBeUndefined();
    // and a valid sibling survives
    const read2 = () => JSON.stringify({ thinkingLevels: { a: "ultra", b: "high" } });
    expect(readThinkingPreference("x", "b", read2)).toBe("high");
  });

  test("writing rejects a non-canonical level loudly", () => {
    const file = tmpFile();
    expect(() => setThinkingPreference(file, "a", "ultra" as never)).toThrow();
  });

  test("clear removes only that endpoint; no-op when absent", () => {
    const file = tmpFile();
    setThinkingPreference(file, "a", "low");
    setThinkingPreference(file, "b", "high");
    clearThinkingPreference(file, "a");
    expect(readThinkingPreference(file, "a")).toBeUndefined();
    expect(readThinkingPreference(file, "b")).toBe("high");
    clearThinkingPreference(file, "missing");
    expect(readUserConfigFile(file).thinkingLevels).toEqual({ b: "high" });
  });

  test("missing section/file reads as no preference", () => {
    expect(readThinkingPreference(tmpFile(), "a")).toBeUndefined();
  });
});
