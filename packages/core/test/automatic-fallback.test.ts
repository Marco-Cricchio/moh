import { describe, expect, test } from "bun:test";
import { resolveProvider, resolveProviderRef, defaultRegistry, type ProviderHealthEstimator } from "../src/provider-registry";
import type { Route } from "../src/route";
import type { EndpointProfile } from "../src/config";

/**
 * ADR-0012 (#234): the fallback chain is built automatically from the
 * configured providers, starting from the active one. Tested through the
 * public resolution seam (`resolveProviderRef` / `resolveProvider`) via
 * the Route `chain` property, never against internal helpers.
 */

function profile(fields: Partial<EndpointProfile> & { name: string; type: string }): EndpointProfile {
  return { ...fields } as EndpointProfile;
}

const endpoints: EndpointProfile[] = [
  profile({ name: "zai", type: "openai-compat", baseUrl: "https://z.ai/api", defaultModel: "glm-5.3" }),
  profile({ name: "openai", type: "openai", defaultModel: "gpt-5.6-terra" }),
  profile({ name: "google", type: "google", defaultModel: "gemini-3-pro" }),
  profile({ name: "local", type: "openai-compat", baseUrl: "http://localhost:11434" }), // no defaultModel
  profile({ name: "custom", type: "registered-factory" }), // custom provider: not a route stop
  profile({ name: "excluded", type: "anthropic", defaultModel: "claude-sonant", fallbackEligible: false }),
];

function resolve(ref: string, health?: ProviderHealthEstimator): Route {
  return resolveProviderRef(ref, defaultRegistry.freeze(), endpoints, health ? { health } : undefined) as Route;
}

describe("automatic fallback chains (ADR-0012)", () => {
  test("chain starts at the active provider and appends eligible route stops in declaration order", () => {
    const route = resolve("zai/glm-5.3");
    expect(route.chain).toEqual(["zai/glm-5.3", "openai/gpt-5.6-terra", "google/gemini-3-pro"]);
  });

  test("single configured provider: chain of length 1, mechanism does not engage", () => {
    const route = resolveProviderRef(
      "only/x",
      defaultRegistry.freeze(),
      [profile({ name: "only", type: "openai", defaultModel: "x" })],
    ) as Route;
    expect(route.chain).toEqual(["only/x"]);
  });

  test("endpoints without defaultModel, custom types, and fallbackEligible:false are skipped", () => {
    const route = resolve("zai/glm-5.3");
    expect(route.chain).not.toContain("local/gemini");
    expect(route.chain.join(" ")).not.toMatch(/\bcustom\b/);
    expect(route.chain).not.toContain("excluded/claude-sonant");
  });

  test("health estimator orders fallbacks by known quota descending, unknown last", () => {
    // google: 80% remaining, openai: 40%, zai: unknown (active anyway).
    const health: ProviderHealthEstimator = (p) =>
      p.name === "google" ? 80 : p.name === "openai" ? 40 : undefined;
    const route = resolve("zai/glm-5.3", health);
    expect(route.chain).toEqual(["zai/glm-5.3", "google/gemini-3-pro", "openai/gpt-5.6-terra"]);
  });

  test("unknown-health fallbacks sort after known ones, declaration order as tiebreak", () => {
    // openai unknown now; google known; zai active.
    const health: ProviderHealthEstimator = (p) => (p.name === "google" ? 80 : undefined);
    const route = resolve("zai/glm-5.3", health);
    expect(route.chain).toEqual(["zai/glm-5.3", "google/gemini-3-pro", "openai/gpt-5.6-terra"]);
  });

  test("mock and registered ids bypass the route chain entirely", () => {
    // Registered factory results are plain Providers, not Routes: no chain.
    expect((resolve("mock") as { chain?: string[] }).chain).toBeUndefined();
  });

  test("bare endpoint ref uses defaultModel for the active stop", () => {
    expect(resolve("zai").chain[0]).toBe("zai/glm-5.3");
  });

  test("switching the active endpoint rebuilds the chain around it (the /model path)", () => {
    // session.switchModel re-runs resolveProviderRef for the new ref —
    // the chain must re-center on the new active provider.
    expect(resolve("openai/gpt-5.6-terra").chain).toEqual([
      "openai/gpt-5.6-terra",
      "zai/glm-5.3",
      "google/gemini-3-pro",
    ]);
  });

  test("resolveProvider threads the chain through config resolution", () => {
    const route = resolveProvider({
      provider: "zai/glm-5.3",
      endpoints,
    }) as Route;
    expect(route.chain).toEqual(["zai/glm-5.3", "openai/gpt-5.6-terra", "google/gemini-3-pro"]);
  });
});
