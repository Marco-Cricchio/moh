import { describe, expect, test } from "bun:test";
import { endpointModelCatalog } from "../src/model-catalog";
import { PROVIDER_PROFILES } from "../src/provider-profiles";
import { resolveProvider } from "../src/provider-registry";
import { resolveApiKey } from "../src/route";

const ids: string[] = [
  "deepseek", "groq", "cerebras", "nvidia-nim", "together", "fireworks", "huggingface", "mistral",
  "moonshot", "minimax", "zai", "qwen", "xiaomi-mimo", "vercel-ai-gateway", "cloudflare-ai-gateway", "baseten",
];

describe("built-in OpenAI-compatible profiles (#726)", () => {
  test("ship one route-capable, catalog-backed profile for every supported provider", () => {
    expect<string[]>(PROVIDER_PROFILES.map((profile) => profile.id)).toEqual(ids);
    for (const profile of PROVIDER_PROFILES) {
      expect(profile.baseUrl).toMatch(/^https:\/\//);
      expect(profile.apiKeyEnv).toMatch(/_API_KEY$|_TOKEN$/);
      expect(endpointModelCatalog(profile.id)).toContainEqual(expect.objectContaining({ id: profile.defaultModel }));
      const provider = resolveProvider({
        provider: `${profile.id}/${profile.defaultModel}`,
        endpoints: [{ name: profile.id, type: profile.id, defaultModel: profile.defaultModel }],
      });
      expect(provider.name).toBe(`${profile.id}/${profile.defaultModel}`);
    }
  });

  test("uses a documented provider environment variable after the endpoint-specific override", () => {
    expect(resolveApiKey("work", "deepseek", { DEEPSEEK_API_KEY: "provider", MOH_ENDPOINT_WORK_API_KEY: "endpoint" })).toBe("endpoint");
    expect(resolveApiKey("work", "deepseek", { DEEPSEEK_API_KEY: "provider" })).toBe("provider");
  });
});
