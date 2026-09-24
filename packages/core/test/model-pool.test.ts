/**
 * #787: the model pool — which real models a session can route to.
 * Catalogs are synchronous metadata; a catalog-less endpoint's live
 * listing is fetched once per session and a failure degrades the pool
 * instead of erroring.
 */
import { describe, expect, test } from "bun:test";
import type { EndpointProfile } from "../src/config";
import { blendedPrice, createModelPool } from "../src/model-pool";

const anthropic: EndpointProfile = { name: "a", type: "anthropic", defaultModel: "claude-sonnet-4-5" };

describe("createModelPool (#787)", () => {
  test("a catalog-backed endpoint contributes its catalog models with blended prices", async () => {
    const pool = createModelPool([anthropic]);

    const { models } = await pool();

    expect(models.length).toBeGreaterThan(5);
    const sonnet = models.find((m) => m.ref === "a/claude-sonnet-4-5");
    expect(sonnet).toBeDefined();
    expect(sonnet!.price).toBeGreaterThan(0);
    expect(models.every((m) => m.ref.startsWith("a/"))).toBe(true);
  });

  test("price is the blended input+output rate; a zero-only record counts as unknown", () => {
    expect(blendedPrice({ input: 3, output: 15 })).toBe(18);
    expect(blendedPrice({ input: 0, output: 0 })).toBeUndefined();
    expect(blendedPrice(undefined)).toBeUndefined();
  });

  test("a catalog-less endpoint's models come from the live listing, priced cross-catalog", async () => {
    const calls: string[] = [];
    const endpoint: EndpointProfile = {
      name: "local",
      type: "openai-compat",
      baseUrl: "http://localhost:1234/v1",
      defaultModel: "x",
    };
    const pool = createModelPool([endpoint], {
      listModels: async (baseUrl) => {
        calls.push(baseUrl);
        return ["some-model", "claude-sonnet-4-5"];
      },
    });

    const { models } = await pool();

    expect(calls).toEqual(["http://localhost:1234/v1"]);
    expect(models.map((m) => m.ref)).toEqual(["local/some-model", "local/claude-sonnet-4-5"]);
    // An id another shipped catalog prices gets a price; an unknown one none.
    const priced = models.find((m) => m.ref === "local/claude-sonnet-4-5")!;
    expect(priced.price).toBe(18); // 3 in + 15 out per Mtok
    expect(models.find((m) => m.ref === "local/some-model")!.price).toBeUndefined();
  });

  test("the pool is resolved once per session (one listing per endpoint)", async () => {
    let calls = 0;
    const pool = createModelPool(
      [{ name: "local", type: "openai-compat", baseUrl: "http://localhost:1234/v1" }],
      {
        listModels: async () => {
          calls += 1;
          return ["m1"];
        },
      },
    );

    await pool();
    await pool();

    expect(calls).toBe(1);
  });

  test("a failed listing contributes nothing and warns — never throws", async () => {
    const pool = createModelPool(
      [
        { name: "local", type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
        anthropic,
      ],
      {
        listModels: async () => {
          throw new Error("HTTP 500");
        },
      },
    );

    const { models, warnings } = await pool();

    expect(models.some((m) => m.ref.startsWith("local/"))).toBe(false);
    expect(models.some((m) => m.ref.startsWith("a/"))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe('endpoint "local": listing failed (HTTP 500)');
  });

  test("a recognized compat host uses shipped metadata (no live listing)", async () => {
    let calls = 0;
    const pool = createModelPool(
      [{ name: "z", type: "openai-compat", baseUrl: "https://api.z.ai/api/paas/v4" }],
      {
        listModels: async () => {
          calls += 1;
          return [];
        },
      },
    );

    const { models } = await pool();

    expect(calls).toBe(0);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.ref.startsWith("z/"))).toBe(true);
  });

  test("refs are deduplicated, and a custom type with no baseUrl contributes nothing", async () => {
    const pool = createModelPool([
      { name: "c", type: "my-custom" },
      { name: "a", type: "anthropic" },
      { name: "a", type: "anthropic" },
    ]);

    const { models } = await pool();

    expect(models.every((m) => m.ref.startsWith("a/"))).toBe(true);
    expect(new Set(models.map((m) => m.ref)).size).toBe(models.length);
  });
});
