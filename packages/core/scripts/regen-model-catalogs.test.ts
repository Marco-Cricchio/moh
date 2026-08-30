import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseModelId,
  buildThinkingIndex,
  deriveThinkingLevelMaps,
  normalizeModelId,
  type Catalog,
} from "./regen-model-catalogs";

const map = { off: null, low: "low", high: "high" };
const key = (id: string, api: string) => `${normalizeModelId(id)}\0${api}`;

describe("#338 thinking-map derivation", () => {
  test("id helpers strip vendor prefixes and variant suffixes", () => {
    expect(baseModelId("anthropic/claude-haiku-4.5:batch")).toBe("claude-haiku-4.5");
    expect(baseModelId("openai/o3")).toBe("o3");
    expect(baseModelId("claude-haiku-4.5")).toBe("claude-haiku-4.5");
    expect(normalizeModelId("claude-haiku-4.5")).toBe("claudehaiku45");
  });

  test("index keys are (id, api) pairs — same wire only", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-regen-"));
    writeFileSync(
      join(dir, "a.json"),
      JSON.stringify({ "openai-completions": { o3: { id: "o3", reasoning: true, thinkingLevelMap: map } } }),
    );
    const index = buildThinkingIndex(dir);
    expect(index.get(key("o3", "openai-completions"))).toEqual(map);
    expect(index.has(key("o3", "anthropic-messages"))).toBe(false);
  });

  test("derives by exact base-id + same-api match, never cross-wire", () => {
    const index = new Map([[key("gpt-5.6", "openai-completions"), map]]);
    const catalog: Catalog = {
      "openai-completions": {
        "openai/gpt-5.6": { id: "openai/gpt-5.6", reasoning: true },
        "openai/gpt-5.6:free": { id: "openai/gpt-5.6:free", reasoning: true },
        "openai/other-model": { id: "openai/other-model", reasoning: true }, // no match: untouched
        "openai/plain": { id: "openai/plain" }, // not reasoning: untouched
        "openai/mapped": { id: "openai/mapped", reasoning: true, thinkingLevelMap: { off: null } },
      },
      // same id on a different wire: the map must NOT cross wires
      "anthropic-messages": { "openai/gpt-5.6": { id: "openai/gpt-5.6", reasoning: true } },
    };
    expect(deriveThinkingLevelMaps(catalog, index)).toBe(2);
    const oc = catalog["openai-completions"]!;
    expect(oc["openai/gpt-5.6"]!.thinkingLevelMap).toEqual(map);
    expect(oc["openai/gpt-5.6:free"]!.thinkingLevelMap).toEqual(map);
    expect(oc["openai/other-model"]!.thinkingLevelMap).toBeUndefined();
    expect(oc["openai/plain"]!.thinkingLevelMap).toBeUndefined();
    expect(oc["openai/mapped"]!.thinkingLevelMap).toEqual({ off: null });
    expect(catalog["anthropic-messages"]!["openai/gpt-5.6"]!.thinkingLevelMap).toBeUndefined();
  });

  test("derivation is deterministic: same input twice, same output", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-regen-"));
    writeFileSync(
      join(dir, "src.json"),
      JSON.stringify({ "openai-completions": { m1: { id: "m1", reasoning: true, thinkingLevelMap: map } } }),
    );
    const run = () => {
      const catalog: Catalog = { "openai-completions": { "v/m1": { id: "v/m1", reasoning: true } } };
      deriveThinkingLevelMaps(catalog, buildThinkingIndex(dir));
      return catalog;
    };
    expect(run()).toEqual(run());
  });

  test("a reasoning dict (not just true) qualifies for derivation", () => {
    const index = new Map([[key("glm-5", "api"), map]]);
    const catalog: Catalog = { api: { "z-ai/glm-5": { id: "z-ai/glm-5", reasoning: { effort: true } } } };
    expect(deriveThinkingLevelMaps(catalog, index)).toBe(1);
  });
});
