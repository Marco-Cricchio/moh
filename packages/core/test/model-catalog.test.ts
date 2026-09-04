import { describe, expect, test } from "bun:test";
import { endpointModelCatalog, knownCompatEndpointMetadata, modelSupportsImages, subscriptionModelCatalog } from "../src/model-catalog";

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

  test("a Z.ai openai-compat endpoint gets pi-ai model metadata by host", () => {
    for (const baseUrl of [
      "https://api.z.ai/api/paas/v4",
      "https://api.z.ai/api/coding/paas/v4",
    ]) {
      const glm = endpointModelCatalog("openai-compat", baseUrl).find((model) => model.id === "glm-5.3");
      expect(glm?.contextWindow).toBe(1_000_000);
      expect(glm?.reasoning).toBe(true);
    }
  });

  test("recognized Z.ai metadata also names the safe reasoning declaration", () => {
    expect(knownCompatEndpointMetadata("https://api.z.ai/api/coding/paas/v4")).toEqual({
      catalog: "zai",
      thinking: { format: "openai-effort", levels: ["off", "low", "high", "max"] },
    });
  });

  test("other openai-compat hosts remain catalog-less", () => {
    expect(endpointModelCatalog("openai-compat", "https://api.deepseek.com/v1")).toEqual([]);
    expect(knownCompatEndpointMetadata("https://api.deepseek.com/v1")).toBeUndefined();
    expect(endpointModelCatalog("openai-compat", "not a url")).toEqual([]);
  });
});

describe("modelSupportsImages — endpoint capability declaration (#490)", () => {
  const noEntry = undefined; // openai-compat / custom: no catalog entry

  test("absent declaration: not image-capable — never invented", () => {
    expect(modelSupportsImages(noEntry)).toBe(false);
    expect(modelSupportsImages(noEntry, {})).toBe(false);
  });

  test("explicit `multimodal: true` declares the capability", () => {
    expect(modelSupportsImages(noEntry, { multimodal: true })).toBe(true);
  });

  test("catalog-backed: declaration can only veto, never grant", () => {
    const entry = { id: "m", name: "m", contextWindow: 1, reasoning: false, input: ["text"] };
    expect(modelSupportsImages(entry)).toBe(false);
    // Cannot grant what the catalog denies.
    expect(modelSupportsImages(entry, { multimodal: true })).toBe(false);
    // But it can veto what the catalog grants.
    const vision = { ...entry, input: ["text", "image"] };
    expect(modelSupportsImages(vision)).toBe(true);
    expect(modelSupportsImages(vision, { multimodal: false })).toBe(false);
  });
});
