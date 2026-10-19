import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_PROFILES } from "../src/provider-profiles";
import { OAUTH_BUILTIN_BASE_URLS, OAUTH_BUILTIN_KINDS, wireForKind, type OAuthBuiltinKind } from "../src/wire";
import { Endpoint, resolveApiKey, type ProviderKind } from "../src/route";
import { fallbackIneligibleReason, resolveProvider } from "../src/provider-registry";
import { hasLiveListingContract } from "../src/live-model-catalog";
import { BUILTIN_PROVIDER_TYPES } from "../src/provider-onboarding";
import type { Message } from "../src/types";

// Characterization of the hand-written provider-kind lists (#1423): every
// derived structure must equal these literal copies of the values at
// c245467f, order included. Private structures (BUILTIN_KINDS,
// WIRE_FOR_KIND, OPENAI_LISTING_PROFILES, providerApiKey) are pinned
// through the behavior that reads them.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<T extends true>(_: T): void {}

/** The 24 built-in kinds, then the kinds outside the built-in set. */
const KINDS = [
  "anthropic", "openai", "google", "github-copilot", "openrouter", "kimi-coding", "xai",
  "deepseek", "groq", "cerebras", "nvidia-nim", "together", "fireworks", "huggingface", "mistral",
  "moonshot", "minimax", "zai", "qwen", "xiaomi-mimo", "vercel-ai-gateway", "cloudflare-ai-gateway", "baseten",
  "opencode",
  "openai-compat", "mock", "custom", "not-a-provider",
] as const;

const EXPECTED_PROFILES = [
  { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
  { id: "groq", displayName: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile" },
  { id: "cerebras", displayName: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", defaultModel: "llama-3.3-70b" },
  { id: "nvidia-nim", displayName: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", defaultModel: "meta/llama-3.3-70b-instruct" },
  { id: "together", displayName: "Together AI", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "fireworks", displayName: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  { id: "huggingface", displayName: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", apiKeyEnv: "HF_TOKEN", defaultModel: "meta-llama/Llama-3.3-70B-Instruct" },
  { id: "mistral", displayName: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", defaultModel: "mistral-large-latest" },
  { id: "moonshot", displayName: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY", defaultModel: "moonshot-v1-128k" },
  { id: "minimax", displayName: "MiniMax", baseUrl: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY", defaultModel: "MiniMax-Text-01" },
  { id: "zai", displayName: "Z.ai", baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKeyEnv: "ZAI_API_KEY", defaultModel: "glm-4.7" },
  { id: "qwen", displayName: "Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY", defaultModel: "qwen-plus", endpointAlternatives: [{ label: "China", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }] },
  { id: "xiaomi-mimo", displayName: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_MIMO_API_KEY", defaultModel: "mimo-v2-flash" },
  { id: "vercel-ai-gateway", displayName: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", apiKeyEnv: "AI_GATEWAY_API_KEY", defaultModel: "openai/gpt-4o-mini" },
  { id: "cloudflare-ai-gateway", displayName: "Cloudflare AI Gateway", baseUrl: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat", apiKeyEnv: "CLOUDFLARE_API_TOKEN", defaultModel: "meta/llama-3.3-70b-instruct" },
  { id: "baseten", displayName: "Baseten", baseUrl: "https://inference.baseten.co/v1", apiKeyEnv: "BASETEN_API_KEY", defaultModel: "deepseek-ai/DeepSeek-R1" },
] as const;

describe("exported provider-kind lists equal their literal copies (#1423)", () => {
  test("PROVIDER_PROFILES: values, order, key order and declared type", () => {
    assertType<Equal<typeof PROVIDER_PROFILES, typeof EXPECTED_PROFILES>>(true);
    expect(PROVIDER_PROFILES).toEqual(EXPECTED_PROFILES);
    expect(JSON.stringify(PROVIDER_PROFILES)).toBe(JSON.stringify(EXPECTED_PROFILES));
    expect(PROVIDER_PROFILES.map((profile) => Object.keys(profile))).toEqual(EXPECTED_PROFILES.map((profile) => Object.keys(profile)));
  });

  test("OAUTH_BUILTIN_KINDS, OAuthBuiltinKind and OAUTH_BUILTIN_BASE_URLS", () => {
    assertType<Equal<typeof OAUTH_BUILTIN_KINDS, readonly ["github-copilot", "openrouter", "kimi-coding", "xai"]>>(true);
    assertType<Equal<OAuthBuiltinKind, "github-copilot" | "openrouter" | "kimi-coding" | "xai">>(true);
    assertType<Equal<typeof OAUTH_BUILTIN_BASE_URLS, Record<OAuthBuiltinKind, string>>>(true);
    expect([...OAUTH_BUILTIN_KINDS]).toEqual(["github-copilot", "openrouter", "kimi-coding", "xai"]);
    expect(OAUTH_BUILTIN_BASE_URLS).toEqual({
      "github-copilot": "https://api.individual.githubcopilot.com",
      openrouter: "https://openrouter.ai/api/v1",
      "kimi-coding": "https://api.kimi.com/coding",
      xai: "https://api.x.ai/v1",
    });
    expect(Object.keys(OAUTH_BUILTIN_BASE_URLS)).toEqual(["github-copilot", "openrouter", "kimi-coding", "xai"]);
  });

  test("ProviderKind is the 24 built-in kinds plus mock and custom", () => {
    assertType<Equal<ProviderKind, Exclude<(typeof KINDS)[number], "openai-compat" | "not-a-provider">>>(true);
  });

  test("ProviderKind is exactly today's 26-member union", () => {
    type ProviderKindToday =
      | "anthropic" | "openai" | "google" | "github-copilot" | "openrouter" | "kimi-coding" | "xai"
      | "deepseek" | "groq" | "cerebras" | "nvidia-nim" | "together" | "fireworks" | "huggingface" | "mistral"
      | "moonshot" | "minimax" | "zai" | "qwen" | "xiaomi-mimo" | "vercel-ai-gateway" | "cloudflare-ai-gateway" | "baseten"
      | "opencode" | "mock" | "custom";
    assertType<Equal<ProviderKind, ProviderKindToday>>(true);
    // The check bites: one member more and one member less both fail.
    // @ts-expect-error a union with an extra member is not ProviderKind
    assertType<Equal<ProviderKind, ProviderKindToday | "echo">>(true);
    // @ts-expect-error a union missing a member is not ProviderKind
    assertType<Equal<ProviderKind, Exclude<ProviderKindToday, "custom">>>(true);
  });

  test("BUILTIN_PROVIDER_TYPES (onboarding order, built on PROVIDER_PROFILES)", () => {
    expect([...BUILTIN_PROVIDER_TYPES]).toEqual([
      "anthropic", "openai", "google", "openai-compat", "github-copilot", "openrouter", "kimi-coding", "xai", "opencode",
      "deepseek", "groq", "cerebras", "nvidia-nim", "together", "fireworks", "huggingface", "mistral",
      "moonshot", "minimax", "zai", "qwen", "xiaomi-mimo", "vercel-ai-gateway", "cloudflare-ai-gateway", "baseten",
    ]);
  });
});

describe("private provider-kind lists, pinned through behavior (#1423)", () => {
  test("wireForKind (WIRE_FOR_KIND) for every kind, exact message for the others", () => {
    const wires = Object.fromEntries(
      KINDS.map((kind) => {
        try {
          return [kind, wireForKind(kind)];
        } catch (error) {
          return [kind, `throws: ${(error as Error).message}`];
        }
      }),
    );
    expect(wires).toEqual({
      anthropic: "anthropic-messages",
      openai: "openai-chat",
      google: "google",
      "github-copilot": "openai-chat",
      openrouter: "openai-chat",
      "kimi-coding": "anthropic-messages",
      xai: "openai-chat",
      deepseek: "openai-chat",
      groq: "openai-chat",
      cerebras: "openai-chat",
      "nvidia-nim": "openai-chat",
      together: "openai-chat",
      fireworks: "openai-chat",
      huggingface: "openai-chat",
      mistral: "openai-chat",
      moonshot: "openai-chat",
      minimax: "openai-chat",
      zai: "openai-chat",
      qwen: "openai-chat",
      "xiaomi-mimo": "openai-chat",
      "vercel-ai-gateway": "openai-chat",
      "cloudflare-ai-gateway": "openai-chat",
      baseten: "openai-chat",
      opencode: "openai-chat",
      "openai-compat": "openai-chat",
      mock: 'throws: provider kind "mock" has no wire mapping; it cannot use the default AI SDK factory',
      custom: 'throws: provider kind "custom" has no wire mapping; it cannot use the default AI SDK factory',
      "not-a-provider": 'throws: provider kind "not-a-provider" has no wire mapping; it cannot use the default AI SDK factory',
    });
    expect(() => wireForKind("")).toThrow(new Error('provider kind "" has no wire mapping; it cannot use the default AI SDK factory'));
  });

  test("hasLiveListingContract (OPENAI_LISTING_PROFILES and the bespoke contracts)", () => {
    const listed = KINDS.filter((kind) => hasLiveListingContract(kind));
    expect(listed).toEqual([
      "anthropic", "openai", "google", "github-copilot", "openrouter", "kimi-coding", "xai",
      "deepseek", "groq", "cerebras", "nvidia-nim", "together", "fireworks", "huggingface", "mistral",
      "moonshot", "minimax", "zai", "qwen", "xiaomi-mimo", "vercel-ai-gateway", "cloudflare-ai-gateway",
      "opencode",
    ]);
  });

  test("fallbackIneligibleReason (BUILTIN_KINDS via isRouteCapable)", () => {
    const reasons = Object.fromEntries(KINDS.map((kind) => [kind, fallbackIneligibleReason({ name: "ep", type: kind, defaultModel: "m" })]));
    const routeCapable = KINDS.filter((kind) => reasons[kind] === null);
    expect(routeCapable).toEqual(KINDS.slice(0, 25));
    expect(reasons.mock).toBe('provider type "mock" cannot be a fallback stop (only built-in and openai-compat endpoints can)');
    expect(reasons.custom).toBe('provider type "custom" cannot be a fallback stop (only built-in and openai-compat endpoints can)');
    expect(reasons["not-a-provider"]).toBe('provider type "not-a-provider" cannot be a fallback stop (only built-in and openai-compat endpoints can)');
  });

  test("resolveApiKey (providerApiKey): the provider variable per kind", () => {
    const env: Record<string, string> = {};
    for (const name of PROVIDER_ENV_VARS) env[name] = `env:${name}`;
    const keys = Object.fromEntries(KINDS.map((kind) => [kind, resolveApiKey("work", kind, env) ?? null]));
    expect(keys).toEqual({
      anthropic: null,
      openai: null,
      google: null,
      "github-copilot": null,
      openrouter: null,
      "kimi-coding": null,
      xai: null,
      deepseek: "env:DEEPSEEK_API_KEY",
      groq: "env:GROQ_API_KEY",
      cerebras: "env:CEREBRAS_API_KEY",
      "nvidia-nim": "env:NVIDIA_API_KEY",
      together: "env:TOGETHER_API_KEY",
      fireworks: "env:FIREWORKS_API_KEY",
      huggingface: "env:HF_TOKEN",
      mistral: "env:MISTRAL_API_KEY",
      moonshot: "env:MOONSHOT_API_KEY",
      minimax: "env:MINIMAX_API_KEY",
      zai: "env:ZAI_API_KEY",
      qwen: "env:DASHSCOPE_API_KEY",
      "xiaomi-mimo": "env:XIAOMI_MIMO_API_KEY",
      "vercel-ai-gateway": "env:AI_GATEWAY_API_KEY",
      "cloudflare-ai-gateway": "env:CLOUDFLARE_API_TOKEN",
      baseten: "env:BASETEN_API_KEY",
      opencode: "env:OPENCODE_API_KEY",
      "openai-compat": null,
      mock: null,
      custom: null,
      "not-a-provider": null,
    });
  });

  test("the opencode branch of providerApiKey", () => {
    // Variable present, for both products (the key does not depend on the endpoint name).
    expect(resolveApiKey("opencode-zen", "opencode", { OPENCODE_API_KEY: "oc" })).toBe("oc");
    expect(resolveApiKey("opencode-go", "opencode", { OPENCODE_API_KEY: "oc" })).toBe("oc");
    // Variable absent.
    expect(resolveApiKey("opencode-zen", "opencode", {})).toBeUndefined();
    expect(resolveApiKey("opencode-go", "opencode", { OPENAI_API_KEY: "other" })).toBeUndefined();
    // The endpoint-specific variable wins.
    expect(resolveApiKey("opencode-go", "opencode", { OPENCODE_API_KEY: "oc", MOH_ENDPOINT_OPENCODE_GO_API_KEY: "endpoint" })).toBe("endpoint");
    // Endpoint: inline key first, then the endpoint variable, then OPENCODE_API_KEY.
    const saved = { oc: process.env.OPENCODE_API_KEY, ep: process.env.MOH_ENDPOINT_OPENCODE_ZEN_API_KEY };
    try {
      process.env.OPENCODE_API_KEY = "oc";
      delete process.env.MOH_ENDPOINT_OPENCODE_ZEN_API_KEY;
      expect(new Endpoint({ name: "opencode-zen", kind: "opencode", apiKey: "inline" }).apiKey).toBe("inline");
      expect(new Endpoint({ name: "opencode-zen", kind: "opencode" }).apiKey).toBe("oc");
      process.env.MOH_ENDPOINT_OPENCODE_ZEN_API_KEY = "endpoint";
      expect(new Endpoint({ name: "opencode-zen", kind: "opencode" }).apiKey).toBe("endpoint");
      delete process.env.OPENCODE_API_KEY;
      delete process.env.MOH_ENDPOINT_OPENCODE_ZEN_API_KEY;
      expect(new Endpoint({ name: "opencode-zen", kind: "opencode" }).apiKey).toBeUndefined();
    } finally {
      restoreEnv("OPENCODE_API_KEY", saved.oc);
      restoreEnv("MOH_ENDPOINT_OPENCODE_ZEN_API_KEY", saved.ep);
    }
  });
});

/** Every provider credential variable a backend or the AI SDK may read. */
const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "NVIDIA_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "HF_TOKEN",
  "MISTRAL_API_KEY", "MOONSHOT_API_KEY", "MINIMAX_API_KEY", "ZAI_API_KEY", "DASHSCOPE_API_KEY", "XIAOMI_MIMO_API_KEY",
  "AI_GATEWAY_API_KEY", "CLOUDFLARE_API_TOKEN", "BASETEN_API_KEY", "OPENCODE_API_KEY",
];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

type RouteOutcome = { name: string; url?: string; credential?: string | null; streamError?: string } | { error: string };

/** Resolves `ep/probe-model` for one endpoint profile and captures the first
 * request the route sends: URL (base URL + wire path) and the credential
 * header. The fetch is aborted, so nothing leaves the process. */
async function routeOutcome(profile: { type: string; name?: string; baseUrl?: string; apiKey?: string }): Promise<RouteOutcome> {
  const name = profile.name ?? "ep";
  let provider;
  try {
    provider = resolveProvider({ provider: `${name}/probe-model`, endpoints: [{ ...profile, name }] });
  } catch (error) {
    return { error: (error as Error).message };
  }
  const abort = new AbortController();
  let call: { url: string; credential: string | null } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    call = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      credential: headers.get("authorization") ?? headers.get("x-api-key") ?? headers.get("x-goog-api-key"),
    };
    abort.abort();
    throw new DOMException("aborted", "AbortError");
  }) as unknown as typeof fetch;
  let streamError: string | undefined;
  try {
    for await (const _ of provider.stream([{ role: "user", parts: [{ kind: "text", text: "hi" }] }] as Message[], abort.signal)) {
      // drained
    }
  } catch (error) {
    streamError = String(error);
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (call) return { name: provider.name, url: call.url, credential: call.credential };
  return streamError === undefined ? { name: provider.name } : { name: provider.name, streamError };
}

describe("route resolution for every kind (#1423, in place of a B2 scenario)", () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "moh-provider-kinds-"));
    for (const name of [...PROVIDER_ENV_VARS, "HOME", "MOH_ENDPOINT_EP_API_KEY", "MOH_ENDPOINT_OPENCODE_GO_API_KEY"]) saved[name] = process.env[name];
    // An empty home: no stored API key or token can be picked up.
    process.env.HOME = home;
    delete process.env.MOH_ENDPOINT_EP_API_KEY;
    delete process.env.MOH_ENDPOINT_OPENCODE_GO_API_KEY;
    for (const name of PROVIDER_ENV_VARS) process.env[name] = `env:${name}`;
    // Google's SDK falls back to this variable; unset it so the outcome shows
    // that moh itself supplies no key for the google kind.
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) restoreEnv(name, value);
    rmSync(home, { recursive: true, force: true });
  });

  test("each kind with a minimal profile", async () => {
    const outcomes: Record<string, RouteOutcome> = {};
    for (const kind of KINDS) outcomes[kind] = await routeOutcome({ type: kind });
    const route = (url: string, credential: string): RouteOutcome => ({ name: "ep/probe-model", url, credential });
    expect(outcomes).toEqual({
      anthropic: route("https://api.anthropic.com/v1/messages", "env:ANTHROPIC_API_KEY"),
      openai: route("https://api.openai.com/v1/chat/completions", "Bearer env:OPENAI_API_KEY"),
      google: {
        name: "ep/probe-model",
        streamError:
          "ProviderError: Google Generative AI API key is missing. Pass it using the 'apiKey' parameter or the GOOGLE_GENERATIVE_AI_API_KEY environment variable.",
      },
      "github-copilot": route("https://api.individual.githubcopilot.com/chat/completions", "Bearer env:OPENAI_API_KEY"),
      openrouter: route("https://openrouter.ai/api/v1/chat/completions", "Bearer env:OPENAI_API_KEY"),
      "kimi-coding": route("https://api.kimi.com/coding/messages", "env:ANTHROPIC_API_KEY"),
      xai: route("https://api.x.ai/v1/chat/completions", "Bearer env:OPENAI_API_KEY"),
      deepseek: route("https://api.deepseek.com/chat/completions", "Bearer env:DEEPSEEK_API_KEY"),
      groq: route("https://api.groq.com/openai/v1/chat/completions", "Bearer env:GROQ_API_KEY"),
      cerebras: route("https://api.cerebras.ai/v1/chat/completions", "Bearer env:CEREBRAS_API_KEY"),
      "nvidia-nim": route("https://integrate.api.nvidia.com/v1/chat/completions", "Bearer env:NVIDIA_API_KEY"),
      together: route("https://api.together.xyz/v1/chat/completions", "Bearer env:TOGETHER_API_KEY"),
      fireworks: route("https://api.fireworks.ai/inference/v1/chat/completions", "Bearer env:FIREWORKS_API_KEY"),
      huggingface: route("https://router.huggingface.co/v1/chat/completions", "Bearer env:HF_TOKEN"),
      mistral: route("https://api.mistral.ai/v1/chat/completions", "Bearer env:MISTRAL_API_KEY"),
      moonshot: route("https://api.moonshot.ai/v1/chat/completions", "Bearer env:MOONSHOT_API_KEY"),
      minimax: route("https://api.minimax.io/v1/chat/completions", "Bearer env:MINIMAX_API_KEY"),
      zai: route("https://api.z.ai/api/coding/paas/v4/chat/completions", "Bearer env:ZAI_API_KEY"),
      qwen: route("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", "Bearer env:DASHSCOPE_API_KEY"),
      "xiaomi-mimo": route("https://api.xiaomimimo.com/v1/chat/completions", "Bearer env:XIAOMI_MIMO_API_KEY"),
      "vercel-ai-gateway": route("https://ai-gateway.vercel.sh/v1/chat/completions", "Bearer env:AI_GATEWAY_API_KEY"),
      "cloudflare-ai-gateway": route("https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions", "Bearer env:CLOUDFLARE_API_TOKEN"),
      baseten: route("https://inference.baseten.co/v1/chat/completions", "Bearer env:BASETEN_API_KEY"),
      opencode: route("https://opencode.ai/zen/v1/chat/completions", "Bearer env:OPENCODE_API_KEY"),
      "openai-compat": { error: 'endpoint "ep": openai-compat requires baseUrl' },
      mock: { name: "mock" },
      custom: { error: 'endpoint "ep": unknown provider type "custom" (not a built-in and not registered)' },
      "not-a-provider": { error: 'endpoint "ep": unknown provider type "not-a-provider" (not a built-in and not registered)' },
    });
  });

  test("openai-compat with a base URL, opencode Go, inline and endpoint keys", async () => {
    expect(await routeOutcome({ type: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" })).toEqual({
      name: "ep/probe-model",
      url: "http://127.0.0.1:9/v1/chat/completions",
      credential: "Bearer ollama",
    });
    expect(await routeOutcome({ type: "opencode", name: "opencode-go" })).toEqual({
      name: "opencode-go/probe-model",
      url: "https://opencode.ai/zen/go/v1/chat/completions",
      credential: "Bearer env:OPENCODE_API_KEY",
    });
    expect(await routeOutcome({ type: "opencode", apiKey: "inline" })).toEqual({
      name: "ep/probe-model",
      url: "https://opencode.ai/zen/v1/chat/completions",
      credential: "Bearer inline",
    });
    process.env.MOH_ENDPOINT_OPENCODE_GO_API_KEY = "endpoint";
    try {
      expect(await routeOutcome({ type: "opencode", name: "opencode-go" })).toEqual({
        name: "opencode-go/probe-model",
        url: "https://opencode.ai/zen/go/v1/chat/completions",
        credential: "Bearer endpoint",
      });
    } finally {
      delete process.env.MOH_ENDPOINT_OPENCODE_GO_API_KEY;
    }
  });
});
