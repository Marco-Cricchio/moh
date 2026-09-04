import { describe, expect, test } from "bun:test";
import { catalogEntryFor, PI_API_TO_WIRE, subscriptionModelCatalog, vendoredApiNames, vendoredBaseUrls } from "../src/model-catalog";
import { catalogTargetOverrides } from "../src/provider-registry";
import { OAUTH_BUILTIN_BASE_URLS } from "../src/wire";
import { COPILOT_EDITOR_HEADERS } from "../src/auth/github-copilot";
import { resolveProvider } from "../src/provider-registry";
import type { MohConfig } from "../src/config";

describe("new provider catalogs (#164)", () => {
  test("each new provider exposes a non-empty, id-unique list", () => {
    for (const type of ["github-copilot", "openrouter", "kimi-coding", "xai"] as const) {
      const models = subscriptionModelCatalog(type);
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.wire).toBeDefined();
      }
      expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    }
  });

  test("kimi catalog: k3 family, anthropic wire, compat flags carried", () => {
    const ids = subscriptionModelCatalog("kimi-coding").map((m) => m.id);
    expect(ids).toContain("k3");
    expect(ids).toContain("kimi-for-coding");
    const k3 = catalogEntryFor("kimi-coding", "k3")!;
    expect(k3.wire).toBe("anthropic-messages");
    expect(k3.compat?.allowEmptySignature).toBe(true);
  });

  test("xai catalog: grok models, responses wire for grok models", () => {
    const ids = subscriptionModelCatalog("xai").map((m) => m.id);
    expect(ids.some((id) => id.startsWith("grok-"))).toBe(true);
    // pi-ai >= 0.84.3 serves all grok models over the responses API.
    expect(catalogEntryFor("xai", "grok-4.5")!.wire).toBe("openai-responses");
    expect(catalogEntryFor("xai", "grok-4.6")!.wire).toBe("openai-responses");
  });

  test("openrouter catalog: verbatim multi-vendor list", () => {
    const models = subscriptionModelCatalog("openrouter");
    expect(models.length).toBeGreaterThan(300);
    expect(models.every((m) => m.wire !== undefined)).toBe(true); // per-model wire declared
    expect(models.some((m) => m.id.includes("/"))).toBe(true); // vendor-prefixed ids
  });

  test("copilot catalog: per-model wire (claude anthropic, gpt responses) + editor headers", () => {
    const claude = catalogEntryFor("github-copilot", "claude-opus-4.7")!;
    expect(claude.wire).toBe("anthropic-messages");
    expect(claude.headers).toEqual({ ...COPILOT_EDITOR_HEADERS });
    const gpt = catalogEntryFor("github-copilot", "gpt-5.5")!
    expect(gpt.wire).toBe("openai-responses");
    expect(gpt.headers).toEqual({ ...COPILOT_EDITOR_HEADERS });
  });

  test("catalogEntryFor returns undefined for unknown models/providers", () => {
    expect(catalogEntryFor("github-copilot", "no-such-model")).toBeUndefined();
    expect(catalogEntryFor("openai-compat", "anything")).toBeUndefined();
  });
});

describe("route targets pick up catalog metadata (#164)", () => {
  test("copilot claude model gets anthropic wire + editor headers; gpt gets responses", () => {
    const claude = catalogTargetOverrides("github-copilot", "claude-opus-4.7");
    expect(claude.wire).toBe("anthropic-messages");
    expect(claude.headers).toEqual({ ...COPILOT_EDITOR_HEADERS });
    const gpt = catalogTargetOverrides("github-copilot", "gpt-5.5");
    expect(gpt.wire).toBe("openai-responses");
    expect(gpt.headers).toEqual({ ...COPILOT_EDITOR_HEADERS });
  });

  test("unknown model and non-new kinds get no overrides (kind default wire)", () => {
    expect(catalogTargetOverrides("github-copilot", "no-such-model")).toEqual({});
    expect(catalogTargetOverrides("anthropic", "claude-anything")).toEqual({});
  });

  test("resolution path stays intact for the new kinds", () => {
    const provider = resolveProvider({
      provider: "copilot/claude-opus-4.6",
      endpoints: [{ name: "copilot", type: "github-copilot", auth: { kind: "subscription" }, defaultModel: "claude-opus-4.6" }],
    } satisfies MohConfig);
    expect(provider.name).toBe("copilot/claude-opus-4.6");
  });
});

describe("vendored-data drift checks (#164)", () => {
  test("every api name in the vendored files maps to a wire — unmapped means silent model loss", () => {
    for (const api of vendoredApiNames()) {
      expect(PI_API_TO_WIRE[api]).toBeDefined();
    }
  });

  test("vendored baseUrls match the registry's builtin base URLs", () => {
    for (const [kind, baseUrl] of Object.entries(OAUTH_BUILTIN_BASE_URLS)) {
      expect(vendoredBaseUrls(kind)).toContain(baseUrl);
    }
  });
});
