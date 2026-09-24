import { describe, expect, test } from "bun:test";
import { catalogApiNames, catalogBaseUrls, catalogEntryFor, PI_API_TO_WIRE, subscriptionModelCatalog } from "../src/model-catalog";
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

describe("catalog-data drift checks (#164)", () => {
  test("every api name in the shipped files maps to a wire — unmapped means silent model loss", () => {
    for (const api of catalogApiNames()) {
      expect(PI_API_TO_WIRE[api]).toBeDefined();
    }
  });

  test("shipped baseUrls match the registry's builtin base URLs", () => {
    for (const [kind, baseUrl] of Object.entries(OAUTH_BUILTIN_BASE_URLS)) {
      expect(catalogBaseUrls(kind)).toContain(baseUrl);
    }
  });
});

describe("OpenCode packaged overlays (#794)", () => {
  test("per-model, per-product wires from the official endpoint tables; conservative metadata", () => {
    const zen = subscriptionModelCatalog("opencode-zen");
    const go = subscriptionModelCatalog("opencode-go");
    expect(zen.length).toBeGreaterThan(0);
    expect(go.length).toBeGreaterThan(0);
    // Same id, different wire per product (official docs): minimax-m3 is
    // chat-completions on Zen, anthropic-messages on Go.
    const wireOf = (list: ReturnType<typeof subscriptionModelCatalog>, id: string) => list.find((m) => m.id === id)?.wire;
    expect(wireOf(zen, "gpt-5.6-terra")).toBe("openai-responses");
    expect(wireOf(zen, "claude-opus-5")).toBe("anthropic-messages");
    expect(wireOf(zen, "minimax-m3")).toBe("openai-chat");
    expect(wireOf(zen, "gemini-3.5-flash")).toBe("google");
    expect(wireOf(go, "grok-4.6")).toBe("openai-responses");
    expect(wireOf(go, "minimax-m3")).toBe("anthropic-messages");
    expect(wireOf(go, "glm-5.3")).toBe("openai-chat");
    // Since #959 the overlays are generated (models.dev, ADR-0046): their
    // metadata is declared by the aggregator, never invented here — every
    // row carries the same fields, and the ids it covers are priced.
    for (const list of [zen, go]) {
      expect(list.every((model) => model.contextWindow > 0 && model.reasoning)).toBe(true);
      expect(list.filter((model) => model.pricing !== undefined).length).toBeGreaterThan(0);
    }
  });

  test("catalogEntryFor resolves OpenCode wires through the endpoint product (baseUrl)", () => {
    const goBase = "https://opencode.ai/zen/go/v1";
    expect(catalogEntryFor("opencode", "minimax-m3")?.wire).toBe("openai-chat");
    expect(catalogEntryFor("opencode", "minimax-m3", goBase)?.wire).toBe("anthropic-messages");
    expect(catalogEntryFor("opencode", "claude-opus-5")?.wire).toBe("anthropic-messages");
    expect(catalogEntryFor("opencode", "unknown-model-x")).toBeUndefined();
  });
});
