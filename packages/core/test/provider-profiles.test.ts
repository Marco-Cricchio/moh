import { describe, expect, test } from "bun:test";
import { endpointModelCatalog } from "../src/model-catalog";
import { PROVIDER_PROFILES } from "../src/provider-profiles";
import { resolveProvider } from "../src/provider-registry";
import { listProviderModels } from "../src/live-model-catalog";
import { imageSupportFor } from "../src/model-catalog";
import { minimalConnectionTest } from "../src/provider-onboarding";
import type { StreamEvent } from "../src/types";
import { resolveApiKey } from "../src/route";

const ids: string[] = [
  "deepseek", "groq", "cerebras", "nvidia-nim", "together", "fireworks", "huggingface", "mistral",
  "moonshot", "minimax", "zai", "qwen", "xiaomi-mimo", "vercel-ai-gateway", "cloudflare-ai-gateway", "baseten", "infomaniak",
];

describe("built-in OpenAI-compatible profiles (#726)", () => {
  test("ship one route-capable, catalog-backed profile for every supported provider", () => {
    expect<string[]>(PROVIDER_PROFILES.map((profile) => profile.id)).toEqual(ids);
    for (const profile of PROVIDER_PROFILES) {
      expect(profile.baseUrl).toMatch(/^https:\/\//);
      expect(profile.apiKeyEnv).toMatch(/_API_KEY$|_TOKEN$/);
      if (profile.id === "infomaniak") expect(endpointModelCatalog(profile.id)).toEqual([]);
      else expect(endpointModelCatalog(profile.id)).toContainEqual(expect.objectContaining({ id: profile.defaultModel }));
      const provider = resolveProvider({
        provider: `${profile.id}/${profile.defaultModel}`,
        endpoints: [{ name: profile.id, type: profile.id, baseUrl: profile.baseUrl.replace(/\{[^}]+\}/g, "123"), defaultModel: profile.defaultModel }],
      });
      expect(provider.name).toBe(`${profile.id}/${profile.defaultModel}`);
    }
  });

  test("uses a documented provider environment variable after the endpoint-specific override", () => {
    expect(resolveApiKey("work", "deepseek", { DEEPSEEK_API_KEY: "provider", MOH_ENDPOINT_WORK_API_KEY: "endpoint" })).toBe("endpoint");
    expect(resolveApiKey("work", "deepseek", { DEEPSEEK_API_KEY: "provider" })).toBe("provider");
  });
});


describe("Infomaniak documented V2 contract", () => {
  test("uses the product URL and bearer token for probe, discovery, image input and streamed tool calls", async () => {
    const calls: { path: string; auth: string | null; body: any }[] = [];
    let singleton = false;
    const server = Bun.serve({ port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "POST" ? await req.json() as any : null;
      calls.push({ path, auth: req.headers.get("authorization"), body });
      if (path.endsWith("/models")) {
        const model = { id: "Qwen/test", object: "model" };
        return Response.json({ object: "list", data: singleton ? model : [model] });
      }
      if (!body.stream) return Response.json({ choices: [{ message: { content: "ok" } }] });
      const chunk = (delta: unknown, finish: string | null = null) => ({ id: "test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      const chunks = [
        chunk({ role: "assistant", content: "ok" }),
        chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"notes.txt"}' } }] }),
        chunk({}, "tool_calls"),
      ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } });
    const profile = { name: "swiss", type: "infomaniak", baseUrl: `http://127.0.0.1:${server.port}/2/ai/123/openai/v1`, apiKey: "test-token", defaultModel: "Qwen/test", capabilities: { imageModels: { "Qwen/test": true } } };
    try {
      expect(await minimalConnectionTest(profile)).toMatchObject({ ok: true });
      expect(await listProviderModels("infomaniak", "swiss", { baseUrl: profile.baseUrl, apiKey: profile.apiKey })).toEqual([{ id: "Qwen/test" }]);
      singleton = true;
      expect(await listProviderModels("infomaniak", "swiss", { baseUrl: profile.baseUrl, apiKey: profile.apiKey })).toEqual([{ id: "Qwen/test" }]);
      expect(imageSupportFor(profile, "Qwen/test").supported).toBe(true);
      expect(imageSupportFor(profile, "unknown").supported).toBe(false);
      const provider = resolveProvider({ provider: "swiss/Qwen/test", endpoints: [profile] });
      const events: StreamEvent[] = [];
      for await (const event of provider.stream([{ role: "user", parts: [{ kind: "text", text: "describe" }, { kind: "image", mime: "image/png", base64: "aGVsbG8=" }] }], AbortSignal.timeout(5000), [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }])) events.push(event);
      expect(events.find((e) => e.type === "tool_calls")).toMatchObject({ calls: [{ name: "read", args: { path: "notes.txt" } }] });
      expect(calls.map((c) => c.path)).toEqual(["/2/ai/123/openai/v1/chat/completions", "/2/ai/123/openai/v1/models", "/2/ai/123/openai/v1/models", "/2/ai/123/openai/v1/chat/completions"]);
      expect(calls.every((c) => c.auth === "Bearer test-token")).toBe(true);
      expect(calls.at(-1)!.body).toMatchObject({ model: "Qwen/test", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }] });
    } finally { server.stop(true); }
  });

  test("requires a concrete product endpoint before sending requests", async () => {
    const profile = { name: "swiss", type: "infomaniak", defaultModel: "qwen3" };
    expect(() => resolveProvider({ provider: "swiss/qwen3", endpoints: [profile] })).toThrow("concrete base URL");
    let calls = 0;
    await expect(listProviderModels("infomaniak", "swiss", { apiKey: "test", fetchImpl: async () => { calls++; return { status: 200, json: {} }; } })).rejects.toThrow("concrete base URL");
    expect(calls).toBe(0);
    expect(resolveApiKey("swiss", "infomaniak", { INFOMANIAK_API_TOKEN: "token" })).toBe("token");
    expect(resolveApiKey("swiss", "infomaniak", { INFOMANIAK_API_TOKEN: "token", MOH_ENDPOINT_SWISS_API_KEY: "override" })).toBe("override");
  });
});
