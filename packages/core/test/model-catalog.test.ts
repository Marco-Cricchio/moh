import { describe, expect, test } from "bun:test";
import { subscriptionModelCatalog } from "../src/model-catalog";

describe("subscriptionModelCatalog (#156)", () => {
  test("anthropic / openai / google each expose a non-empty list", () => {
    for (const type of ["anthropic", "openai", "google"] as const) {
      const models = subscriptionModelCatalog(type);
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
        expect(model.contextWindow).toBeGreaterThan(0);
      }
      // no duplicate ids
      expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    }
  });

  test("known subscription models are present", () => {
    const ids = subscriptionModelCatalog("anthropic").map((m) => m.id);
    expect(ids.some((id) => id.startsWith("claude-"))).toBe(true);
    const codex = subscriptionModelCatalog("openai").map((m) => m.id);
    expect(codex.some((id) => id.includes("codex") || id.startsWith("gpt-"))).toBe(true);
    const google = subscriptionModelCatalog("google").map((m) => m.id);
    expect(google.some((id) => id.startsWith("gemini-"))).toBe(true);
  });

  test("unknown types (openai-compat, custom) get an empty list — free-text fallback", () => {
    expect(subscriptionModelCatalog("openai-compat")).toEqual([]);
    expect(subscriptionModelCatalog("custom-thing")).toEqual([]);
  });
});
