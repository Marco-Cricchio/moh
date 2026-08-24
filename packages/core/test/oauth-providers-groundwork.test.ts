import { describe, expect, test } from "bun:test";
import { wireForKind, OAUTH_BUILTIN_BASE_URLS, OAUTH_BUILTIN_KINDS, isOAuthBuiltinKind } from "../src/wire";
import { authOverridesSchema, authSectionSchema } from "../src/auth/types";
import { tosWarningFor, TOS_WARNING } from "../src/auth/oauth";
import { BUILTIN_PROVIDER_TYPES } from "../src/provider-onboarding";
import { resolveProvider } from "../src/provider-registry";
import type { MohConfig } from "../src/config";

describe("wire separation (#159)", () => {
  test("each builtin kind maps to its wire", () => {
    expect(wireForKind("anthropic")).toBe("anthropic-messages");
    expect(wireForKind("openai")).toBe("openai-chat");
    expect(wireForKind("google")).toBe("google");
    // kimi speaks anthropic-messages against its own backend
    expect(wireForKind("kimi-coding")).toBe("anthropic-messages");
    expect(wireForKind("github-copilot")).toBe("openai-chat"); // per-model override comes from the catalog
    expect(wireForKind("openrouter")).toBe("openai-chat");
    expect(wireForKind("xai")).toBe("openai-chat");
  });

  test("new builtin base URLs point at the vendor backends", () => {
    expect(OAUTH_BUILTIN_BASE_URLS.openrouter).toBe("https://openrouter.ai/api/v1");
    expect(OAUTH_BUILTIN_BASE_URLS.xai).toBe("https://api.x.ai/v1");
    expect(OAUTH_BUILTIN_BASE_URLS["kimi-coding"]).toBe("https://api.kimi.com/coding");
    expect(OAUTH_BUILTIN_BASE_URLS["github-copilot"]).toBe("https://api.individual.githubcopilot.com");
  });

  test("kind membership", () => {
    expect(isOAuthBuiltinKind("xai")).toBe(true);
    expect(isOAuthBuiltinKind("openai")).toBe(false);
    expect(OAUTH_BUILTIN_KINDS).toHaveLength(4);
  });
});

describe("auth store extension (#159)", () => {
  test("overrides section accepts the four new provider blocks", () => {
    const section = authSectionSchema.parse({
      tokens: {},
      overrides: {
        openrouter: { tokenUrl: "https://openrouter.ai/api/v1/auth/keys" },
        "kimi-coding": { oauthHost: "https://auth.kimi.com" },
        xai: { clientId: "b1a00492-073a-47ea-816f-4c329264a828" },
        "github-copilot": { domain: "company.ghe.com" },
      },
    });
    expect(section.overrides?.xai?.clientId).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(section.overrides?.["kimi-coding"]?.oauthHost).toBe("https://auth.kimi.com");
  });

  test("invalid override shapes are rejected", () => {
    expect(authOverridesSchema.safeParse({ openrouter: { tokenUrl: "not a url" } }).success).toBe(false);
    expect(authOverridesSchema.safeParse({ xai: { clientId: "" } }).success).toBe(false);
  });
});

describe("ToS copy per provider (#159)", () => {
  test("each new provider has dedicated copy; others get the generic warning", () => {
    for (const kind of OAUTH_BUILTIN_KINDS) {
      expect(tosWarningFor(kind)).not.toBe(TOS_WARNING);
    }
    expect(tosWarningFor("anthropic")).toBe(TOS_WARNING);
    expect(tosWarningFor("openai")).toBe(TOS_WARNING);
  });
});

describe("registry wiring (#159)", () => {
  test("BUILTIN_PROVIDER_TYPES includes the four new kinds", () => {
    expect(BUILTIN_PROVIDER_TYPES).toContain("github-copilot");
    expect(BUILTIN_PROVIDER_TYPES).toContain("openrouter");
    expect(BUILTIN_PROVIDER_TYPES).toContain("kimi-coding");
    expect(BUILTIN_PROVIDER_TYPES).toContain("xai");
  });

  test("new kinds resolve to routes with the vendor base URL", () => {
    const config: MohConfig = {
      provider: "xai-keyed/grok-4.6",
      endpoints: [{ name: "xai-keyed", type: "xai", apiKey: "k" }],
    };
    expect(() => resolveProvider(config)).not.toThrow();
    const config2: MohConfig = {
      provider: "router/or",
      endpoints: [{ name: "router", type: "openrouter", apiKey: "k", baseUrl: "https://openrouter.ai/api/v1" }],
    };
    expect(() => resolveProvider(config2)).not.toThrow();
  });
});
