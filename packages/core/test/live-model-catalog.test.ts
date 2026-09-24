import { describe, test, expect } from "bun:test";
import {
  parseModelsResponse,
  mergeLiveCatalog,
  hasVendoredCatalog,
  freshCacheEntries,
  loadLiveModelCache,
  saveLiveModelCache,
  fetchLiveCatalogs,
  readLiveModelsConfig,
  listProviderModels,
  hasLiveListingContract,
  liveListings,
  liveCatalogFailureReasons,
  summarizeLiveCatalogReport,
  reportNeedsNotice,
  type LiveCatalogReport,
  CODEX_LISTING_CLIENT_VERSION,
  type LiveModelListing,
} from "../src/live-model-catalog";
import type { CatalogModel } from "../src/model-catalog";
import { BUILTIN_PROVIDER_TYPES } from "../src/provider-onboarding";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shipped: CatalogModel[] = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, reasoning: true, wire: "anthropic-messages" },
];

describe("parseModelsResponse", () => {
  test("parses the ChatGPT/Codex models[].slug contract (#551 audit)", () => {
    const out = parseModelsResponse({
      models: [
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6 Astra",
          context_window: 272_000,
          visibility: "list",
          supported_in_api: true,
          priority: 0,
        },
        { slug: "internal-only", visibility: "hidden", supported_in_api: true },
        { slug: "api-unsupported", visibility: "list", supported_in_api: false },
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", supported_in_api: true },
      ],
    });
    // Only picker-visible, API-supported models become rows.
    expect(out).toEqual([
      { id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 272_000, priority: 0 },
      { id: "gpt-5.5", name: "GPT-5.5" },
    ]);
  });

  test("parses the OpenAI-ish data[] shape", () => {
    const out = parseModelsResponse({
      data: [{ id: "gpt-5.5", display_name: "GPT 5.5", context_length: 400_000 }, { id: "gpt-x" }],
    });
    expect(out).toEqual([
      { id: "gpt-5.5", name: "GPT 5.5", contextWindow: 400_000 },
      { id: "gpt-x" },
    ]);
  });

  test("parses the Google models[] shape, filtering non-generateContent entries", () => {
    const out = parseModelsResponse({
      models: [
        { name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", inputTokenLimit: 1_048_576, supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-1", supportedGenerationMethods: ["embedContent"] },
      ],
    });
    expect(out).toEqual([{ id: "gemini-3-pro", name: "Gemini 3 Pro", contextWindow: 1_048_576 }]);
  });

  test("returns undefined for unrecognized shapes", () => {
    expect(parseModelsResponse({ foo: 1 })).toBeUndefined();
    expect(parseModelsResponse(null)).toBeUndefined();
    expect(parseModelsResponse({ data: { models: [] } })).toBeUndefined();
  });

  test("an empty list is the shape's own answer, not an unrecognized body (#920)", () => {
    expect(parseModelsResponse({ data: [] })).toEqual([]);
    expect(parseModelsResponse({ models: [] })).toEqual([]);
    // A recognized container whose entries are all unusable is empty too —
    // never a different contract's body.
    expect(parseModelsResponse({ data: [{ nope: true }] })).toEqual([]);
  });
});

describe("mergeLiveCatalog", () => {
  test("the shipped catalog wins on id collision; fetched-only are conservative rows", () => {
    const live: LiveModelListing[] = [
      { id: "claude-sonnet-4-5", name: "Impostor", contextWindow: 1 },
      { id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 300_000 },
      { id: "claude-unknown" },
    ];
    const merged = mergeLiveCatalog(shipped, live);
    expect(merged).toEqual([
      ...shipped,
      { id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 300_000, reasoning: false },
      { id: "claude-unknown", name: "claude-unknown", contextWindow: 0, reasoning: false },
    ]);
  });
});

describe("hasVendoredCatalog", () => {
  test("true for catalog-backed kinds, false for openai-compat/custom", () => {
    expect(hasVendoredCatalog("anthropic")).toBe(true);
    expect(hasVendoredCatalog("zai")).toBe(true);
    expect(hasVendoredCatalog("openai-compat")).toBe(false);
    expect(hasVendoredCatalog("custom-thing")).toBe(false);
  });
});

describe("freshCacheEntries", () => {
  test("keeps entries within the TTL, drops expired ones", () => {
    const now = 1_000_000_000_000;
    const fresh = freshCacheEntries(
      {
        a: { fetchedAt: now - 1000, models: [{ id: "x" }] },
        b: { fetchedAt: now - 25 * 3_600_000, models: [{ id: "y" }] },
      },
      24,
      now,
    );
    expect(Object.keys(fresh)).toEqual(["a"]);
  });
});

describe("fetchLiveCatalogs", () => {
  const home = () => mkdtempSync(join(tmpdir(), "moh-live-"));

  test("with no network and no cache, returns empty (static catalog stands)", async () => {
    const dir = home();
    try {
      const out = await fetchLiveCatalogs([{ name: "e", type: "anthropic" }], { mohHome: dir, fetchImpl: async () => { throw new Error("offline"); } });
      // ADR-0045: the failure is the status, not an empty object.
      expect(out.e?.models).toEqual([]);
      expect(out.e?.status.kind).toBe("failed");
      expect(out.e?.status.kind === "failed" && out.e.status.reason).toContain("offline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serves from a fresh cache without fetching; merges new fetches into the cache", async () => {
    const dir = home();
    try {
      const fetchImpl = async () => ({        status: 200,
        json: { data: [{ id: "brand-new-model", display_name: "Brand New" }] },
      });
      const first = await fetchLiveCatalogs([{ name: "my-anthropic", type: "anthropic" }], { mohHome: dir, fetchImpl });
      expect(first["my-anthropic"]?.models).toEqual([{ id: "brand-new-model", name: "Brand New" }]);
      expect(first["my-anthropic"]?.status).toEqual({ kind: "fresh" });

      // Second call within TTL: served from cache, fetch never invoked.
      let called = false;
      const countingFetch = async () => {
        called = true;
        return { status: 200, json: { data: [{ id: "brand-new-model", display_name: "Brand New" }] } };
      };
      const second = await fetchLiveCatalogs([{ name: "my-anthropic", type: "anthropic" }], { mohHome: dir, fetchImpl: countingFetch });
      expect(called).toBe(false);
      expect(second["my-anthropic"]?.models).toEqual([{ id: "brand-new-model", name: "Brand New" }]);
      // ADR-0045: served from a valid cache is the healthy steady state,
      // reported as such with its age — never as a degradation.
      expect(second["my-anthropic"]?.status.kind).toBe("cached");
      expect(second["my-anthropic"]?.status.kind === "cached" && second["my-anthropic"]!.status.ageHours).toBe(0);

      // force bypasses the cache and re-fetches.
      const forced = await fetchLiveCatalogs([{ name: "my-anthropic", type: "anthropic" }], { mohHome: dir, fetchImpl: countingFetch, force: true });
      expect(called).toBe(true);
      expect(forced["my-anthropic"]?.models).toHaveLength(1);
      expect(forced["my-anthropic"]?.status).toEqual({ kind: "fresh" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips non-catalog endpoints (openai-compat stays on the live /models path)", async () => {
    const dir = home();
    try {
      let called = false;
      const out = await fetchLiveCatalogs(
        [
          { name: "compat", type: "openai-compat", baseUrl: "https://x/v1" },
          { name: "custom", type: "my-custom" },
        ],
        { mohHome: dir, fetchImpl: async () => { called = true; return { status: 200, json: { data: [] } }; } },
      );
      expect(called).toBe(false);
      expect(out).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fetches the audited contracts: a #726 profile and Z.ai, never baseten (#920)", async () => {
    const dir = home();
    try {
      const urls: string[] = [];
      const out = await fetchLiveCatalogs(
        [
          { name: "zai", type: "zai" },
          { name: "my-deepseek", type: "deepseek", baseUrl: "https://api.deepseek.com" },
          { name: "baseten", type: "baseten" },
        ],
        {
          mohHome: dir,
          fetchImpl: async (url) => {
            urls.push(url);
            return { status: 200, json: { data: [{ id: `${url.split("/")[2]}-model` }] } };
          },
        },
      );
      expect(urls).toEqual(["https://api.z.ai/api/coding/paas/v4/models", "https://api.deepseek.com/models"]);
      expect(out.zai?.models).toEqual([{ id: "api.z.ai-model" }]);
      expect(out["my-deepseek"]?.models).toEqual([{ id: "api.deepseek.com-model" }]);
      // ADR-0045: no route is static by design, never a failure notice.
      expect(out.baseten).toEqual({ models: [], status: { kind: "unsupported" }, type: "baseten" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("honors liveModels.enabled = false: fully static", async () => {
    const dir = home();
    try {
      const { updateUserConfigFile } = await import("../src/user-config");
      updateUserConfigFile(join(dir, ".moh", "config"), (data) => {
        data.liveModels = { enabled: false };
      });
      let called = false;
      const out = await fetchLiveCatalogs([{ name: "e", type: "anthropic" }], {
        mohHome: dir,
        fetchImpl: async () => { called = true; return { status: 200, json: { data: [{ id: "x" }] } }; },
      });
      expect(called).toBe(false);
      expect(out).toEqual({});
      expect(readLiveModelsConfig(dir).enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expired cache + offline still serves the stale cached list (criterion 4)", async () => {
    const dir = home();
    try {
      // Seed a cache entry that is already past the TTL.
      await saveLiveModelCache(
        { "my-xai": { fetchedAt: Date.now() - 48 * 3_600_000, models: [{ id: "stale-grok" }] } },
        join(dir, ".moh", "live-models.json"),
      );
      const out = await fetchLiveCatalogs([{ name: "my-xai", type: "xai" }], {
        mohHome: dir,
        fetchImpl: async () => {
          throw new Error("offline");
        },
      });
      // ADR-0045: the expired entry is served *and* named, with its age.
      expect(out["my-xai"]?.models).toEqual([{ id: "stale-grok" }]);
      expect(out["my-xai"]?.status.kind).toBe("stale");
      expect(out["my-xai"]?.status.kind === "stale" && out["my-xai"]!.status.ageHours).toBeGreaterThanOrEqual(47);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing endpoint drops no entry and other endpoints still fetch", async () => {
    const dir = home();
    try {
      const out = await fetchLiveCatalogs(
        [
          { name: "good", type: "xai" },
          { name: "bad", type: "anthropic" },
        ],
        {
          mohHome: dir,
          fetchImpl: async (url) => (url.includes("x.ai") ? { status: 200, json: { data: [{ id: "grok-5" }] } } : { status: 500, json: {} }),
        },
      );
      expect(out.good?.models).toEqual([{ id: "grok-5" }]);
      expect(out.good?.status.kind).toBe("fresh");
      // The failure is reported, and it does not take the other endpoint down.
      expect(out.bad?.status.kind).toBe("failed");
      expect(out.bad?.models).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cache round-trip", () => {
  test("corrupt file reads as empty; save is a read-modify-write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-cache-"));
    try {
      const file = join(dir, "live-models.json");
      expect(await loadLiveModelCache(file)).toEqual({});
      await saveLiveModelCache({ a: { fetchedAt: 1, models: [{ id: "m" }] } }, file);
      await saveLiveModelCache({ b: { fetchedAt: 2, models: [] } }, file);
      const cache = await loadLiveModelCache(file);
      expect(cache.a?.models).toEqual([{ id: "m" }]);
      expect(cache.b?.fetchedAt).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listProviderModels", () => {
  test("openai (Codex) sends originator + client_version and parses models[].slug", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const out = await listProviderModels("openai", "e", {
      apiKey: "test-token",
      clientVersion: "0.25.0",
      fetchImpl: async (url, headers) => {
        seenUrl = url;
        seenHeaders = headers;
        return {
          status: 200,
          json: { models: [{ slug: "gpt-6-astra", display_name: "GPT-6 Astra", context_window: 272_000, visibility: "list", supported_in_api: true }] },
        };
      },
    });
    expect(seenUrl).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.25.0");
    expect(seenHeaders.originator).toBe("codex_cli_rs");
    expect(seenHeaders.Authorization).toMatch(/^Bearer /);
    expect(out).toEqual([{ id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 272_000 }]);
  });

  test("anthropic paginates via has_more/after_id and reads display_name", async () => {
    const pages = [
      { data: [{ id: "m1", display_name: "M1" }], has_more: true, last_id: "m1" },
      { data: [{ id: "m2", display_name: "M2" }], has_more: false, last_id: "m2" },
    ];
    const urls: string[] = [];
    const out = await listProviderModels("anthropic", "e", {
      fetchImpl: async (url) => {
        urls.push(url);
        return { status: 200, json: pages[urls.length - 1] };
      },
    });
    expect(urls[0]).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(urls[1]).toBe("https://api.anthropic.com/v1/models?limit=1000&after_id=m1");
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("google paginates via nextPageToken and filters generateContent", async () => {
    const pages = [
      { models: [{ name: "models/a", displayName: "A", inputTokenLimit: 1000, supportedGenerationMethods: ["generateContent"] }], nextPageToken: "T2" },
      { models: [{ name: "models/b", displayName: "B", inputTokenLimit: 2000, supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] },
    ];
    const urls: string[] = [];
    const out = await listProviderModels("google", "e", {
      fetchImpl: async (url) => {
        urls.push(url);
        return { status: 200, json: pages[urls.length - 1] };
      },
    });
    expect(urls[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    expect(urls[1]).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=T2");
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("kimi-coding lists under /v1 on its coding backend (#920)", async () => {
    let url = "";
    const out = await listProviderModels("kimi-coding", "kimi", {
      apiKey: "k",
      fetchImpl: async (u, headers) => {
        url = u;
        expect(headers.Authorization).toBe("Bearer k");
        return { status: 200, json: { data: [{ id: "k3-256k" }] } };
      },
    });
    expect(url).toBe("https://api.kimi.com/coding/v1/models");
    expect(out).toEqual([{ id: "k3-256k" }]);
  });

  test("the #726 profiles list at their documented <baseUrl>/models (#920)", async () => {
    // Z.ai is the owner's own stale list: the coding endpoint answers 11
    // models while the shipped catalog ships 7.
    const zai = await listProviderModels("zai", "zai", {
      apiKey: "k",
      fetchImpl: async (url, headers) => {
        expect(url).toBe("https://api.z.ai/api/coding/paas/v4/models");
        expect(headers.Authorization).toBe("Bearer k");
        return { status: 200, json: { object: "list", data: [{ id: "glm-5.1", object: "model", created: 1, owned_by: "z-ai" }] } };
      },
    });
    expect(zai).toEqual([{ id: "glm-5.1" }]);

    // The endpoint's own baseUrl wins (a regional alternative or a proxy).
    let deepseekUrl = "";
    await listProviderModels("deepseek", "ds", {
      baseUrl: "https://proxy.internal/v1/",
      fetchImpl: async (url) => {
        deepseekUrl = url;
        return { status: 200, json: { data: [{ id: "deepseek-chat" }] } };
      },
    });
    expect(deepseekUrl).toBe("https://proxy.internal/v1//models");
  });

  test("a listing label falls back from display_name to name, and max_context_length to context_length", async () => {
    const out = await listProviderModels("openrouter", "or", {
      fetchImpl: async () => ({
        status: 200,
        json: {
          data: [
            { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", context_length: 1_050_000 },
            { id: "mistral-large-latest", name: "mistral-large-latest", max_context_length: 131_072 },
          ],
        },
      }),
    });
    expect(out).toEqual([
      { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", contextWindow: 1_050_000 },
      { id: "mistral-large-latest", name: "mistral-large-latest", contextWindow: 131_072 },
    ]);
  });

  test("anthropic sends x-api-key + anthropic-version, never a Bearer mix", async () => {
    let seen: Record<string, string> = {};
    await listProviderModels("anthropic", "e", {
      apiKey: "k",
      fetchImpl: async (_url, headers) => {
        seen = headers;
        return { status: 200, json: { data: [{ id: "m" }] } };
      },
    });
    expect(seen["x-api-key"]).toBe("k");
    expect(seen["anthropic-version"]).toBe("2023-06-01");
    expect(seen.Authorization).toBeUndefined();
  });

  test("appends /models exactly once to the provider's base URL", async () => {
    let url = "";
    await listProviderModels("anthropic", "e", {
      fetchImpl: async (u) => {
        url = u;
        return { status: 200, json: { data: [{ id: "m" }], has_more: false } };
      },
    });
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
  });

  test("throws on no verified contract (baseten: its /v1/models is the website, not an inference API)", async () => {
    expect(listProviderModels("baseten", "e")).rejects.toThrow("no verified");
    expect(listProviderModels("my-custom", "e")).rejects.toThrow("no verified");
  });

  test("throws on HTTP failure and on unrecognized shape", async () => {
    expect(listProviderModels("anthropic", "e", { fetchImpl: async () => ({ status: 401, json: {} }) })).rejects.toThrow("HTTP 401");
    expect(listProviderModels("anthropic", "e", { fetchImpl: async () => ({ status: 200, json: { nope: [] } }) })).rejects.toThrow("unrecognized");
  });

  test("a well-formed but empty list is a failure, not an empty catalog (#920)", async () => {
    // The Codex version gate and an account with no access both answer
    // `200 {models: []}`: serving nothing would silently wipe the picker.
    expect(listProviderModels("openai", "e", { fetchImpl: async () => ({ status: 200, json: { models: [] } }) })).rejects.toThrow("empty model list");
    expect(listProviderModels("zai", "e", { fetchImpl: async () => ({ status: 200, json: { data: [] } }) })).rejects.toThrow("empty model list");
    // …while an empty *continuation* page still just ends the pagination.
    const pages = [{ data: [{ id: "m1" }], has_more: true }, { data: [], has_more: false }];
    let n = 0;
    const out = await listProviderModels("anthropic", "e", { fetchImpl: async () => ({ status: 200, json: pages[n++] }) });
    expect(out).toEqual([{ id: "m1" }]);
  });

  test("google sends the key as x-goog-api-key", async () => {
    let seen: Record<string, string> = {};
    await listProviderModels("google", "g", {
      apiKey: "k",
      fetchImpl: async (_url, headers) => {
        seen = headers;
        return { status: 200, json: { models: [{ name: "models/gemini-x", supportedGenerationMethods: ["generateContent"] }] } };
      },
    });
    expect(seen["x-goog-api-key"]).toBe("k");
  });
});
describe("OpenCode live catalogs (#794)", () => {
  test("Zen and Go use their endpoint-shaped bases and Bearer API-key headers", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    for (const [endpoint, expected] of [
      ["opencode-zen", "https://opencode.ai/zen/v1/models"],
      ["opencode-go", "https://opencode.ai/zen/go/v1/models"],
    ]) {
      const models = await listProviderModels("opencode", endpoint, {
        apiKey: "opencode-key",
        fetchImpl: async (url, headers) => {
          calls.push({ url, headers });
          return { status: 200, json: { data: [{ id: `${endpoint}-model` }] } };
        },
      });
      expect(models).toEqual([{ id: `${endpoint}-model` }]);
      expect(calls.at(-1)).toEqual({ url: expected, headers: { Accept: "application/json", Authorization: "Bearer opencode-key" } });
    }
  });
});

describe("OpenCode live-catalog cache and fallback (#794)", () => {
  const home = () => mkdtempSync(join(tmpdir(), "moh-opencode-live-"));
  const zen = { name: "opencode-zen", type: "opencode", baseUrl: "https://opencode.ai/zen/v1" };

  test("uses a fresh endpoint-scoped cache, force refreshes, and keeps stale listings offline", async () => {
    const dir = home();
    try {
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return { status: 200, json: { data: [{ id: `live-${calls}` }] } };
      };
      expect(await fetchLiveCatalogs([zen], { mohHome: dir, fetchImpl })).toEqual({ "opencode-zen": { models: [{ id: "live-1" }], status: { kind: "fresh" }, type: "opencode" } });
      const cached = await fetchLiveCatalogs([zen], { mohHome: dir, fetchImpl });
      expect(cached["opencode-zen"]?.models).toEqual([{ id: "live-1" }]);
      expect(cached["opencode-zen"]?.status.kind).toBe("cached");
      expect(calls).toBe(1);
      expect(await fetchLiveCatalogs([zen], { mohHome: dir, fetchImpl, force: true })).toEqual({ "opencode-zen": { models: [{ id: "live-2" }], status: { kind: "fresh" }, type: "opencode" } });
      await saveLiveModelCache({ "opencode-zen": { fetchedAt: Date.now() - 48 * 3_600_000, models: [{ id: "stale-open-code" }] } }, join(dir, ".moh", "live-models.json"));
      const stale = await fetchLiveCatalogs([zen], { mohHome: dir, fetchImpl: async () => { throw new Error("offline"); } });
      expect(stale["opencode-zen"]?.models).toEqual([{ id: "stale-open-code" }]);
      expect(stale["opencode-zen"]?.status.kind).toBe("stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listing-contract coverage (#920 audit)", () => {
  test("every builtin provider kind has a verified contract, except the one the audit found no route for", () => {
    // Baseten's /v1/models is served by the marketing site (403 + a website
    // CSP), not by an inference API: its shipped catalog stays the update
    // story. Any other kind going static must fail here, loudly.
    const staticByDesign = new Set(["baseten"]);
    for (const type of BUILTIN_PROVIDER_TYPES) {
      if (type === "openai-compat") continue; // arbitrary host: the pickers fetch it themselves (#181)
      expect(hasVendoredCatalog(type)).toBe(true);
      expect(hasLiveListingContract(type)).toBe(!staticByDesign.has(type));
    }
  });

  test("the openai listing asks for the full list, never moh's own version (#920)", async () => {
    // The backend gates each model on `minimal_client_version <=
    // client_version`: moh's version returns an empty list, and the old
    // `0.0.0` default hid the newest two models.
    let url = "";
    await listProviderModels("openai", "openai", {
      apiKey: "t",
      fetchImpl: async (u) => {
        url = u;
        return { status: 200, json: { models: [{ slug: "gpt-6-sol", visibility: "list", supported_in_api: true }] } };
      },
    });
    expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_LISTING_CLIENT_VERSION}`);
    expect(CODEX_LISTING_CLIENT_VERSION).not.toBe("0.0.0");
  });
});

describe("live-catalog status projection (ADR-0045)", () => {
  const report: LiveCatalogReport = {
    fresh: { models: [{ id: "m1" }], status: { kind: "fresh" }, type: "anthropic" },
    cached: { models: [{ id: "m2" }], status: { kind: "cached", ageHours: 3 }, type: "anthropic" },
    stale: { models: [{ id: "m3" }], status: { kind: "stale", ageHours: 30 }, type: "anthropic" },
    failed: { models: [], status: { kind: "failed", reason: "HTTP 401" }, type: "anthropic" },
    static: { models: [], status: { kind: "unsupported" }, type: "baseten" },
  };

  test("the #551 listing projection is derived, not a second source of truth", () => {
    // Only endpoints with live-only models overlay the shipped catalog:
    // a failure or a statically-unsupported provider contributes nothing.
    expect(liveListings(report)).toEqual({
      fresh: [{ id: "m1" }],
      cached: [{ id: "m2" }],
      stale: [{ id: "m3" }],
    });
  });

  test("every status has a line, and only a real failure is called one", () => {
    const summary = summarizeLiveCatalogReport(report)!;
    expect(summary).toContain("fresh refreshed");
    expect(summary).toContain("cached cached (3h)");
    expect(summary).toContain("stale stale (30h, refresh failed)");
    // The reason is a diagnostic, never inlined into user-facing copy.
    expect(summary).toContain("failed unavailable");
    expect(summary).not.toContain("HTTP 401");
    expect(liveCatalogFailureReasons(report)).toEqual(["model listing unavailable: HTTP 401"]);
    // A provider with no listing route is static by design: never phrased
    // as a problem.
    expect(summary).toContain("static static (no listing route)");
    expect(summary).not.toContain("static unavailable");
  });

  test("an empty report has no summary at all", () => {
    expect(summarizeLiveCatalogReport({})).toBeNull();
    expect(liveCatalogFailureReasons({})).toEqual([]);
  });

  test("a stale entry with no models still has the shipped catalog behind it", () => {
    // An expired cache whose entry was itself empty (a listing that once
    // answered 200 with no models) leaves the shipped catalog to show:
    // a usable list, so no interruption.
    expect(reportNeedsNotice({ e: { models: [], status: { kind: "stale", ageHours: 40 }, type: "anthropic" } })).toBe(false);
    // The same shape without a catalog behind it earns the notice.
    expect(reportNeedsNotice({ e: { models: [], status: { kind: "stale", ageHours: 40 }, type: "my-custom" } })).toBe(true);
  });

  test("the notice rule interrupts only when nothing would be left to show", () => {
    // A usable list behind the status — including a stale one — is enough.
    expect(reportNeedsNotice(report)).toBe(false);
    // A failed refresh over a provider whose shipped catalog still shows
    // models leaves the user a list: no notice.
    expect(reportNeedsNotice({ e: { models: [], status: { kind: "failed", reason: "offline" }, type: "anthropic" } })).toBe(false);
    // Nothing behind it at all (no live models, no shipped catalog): notice.
    expect(reportNeedsNotice({ e: { models: [], status: { kind: "failed", reason: "offline" }, type: "my-custom" } })).toBe(true);
    expect(reportNeedsNotice({ e: { models: [], status: { kind: "stale", ageHours: 40 }, type: "my-custom" } })).toBe(true);
    // Static-by-design and healthy outcomes never interrupt.
    expect(reportNeedsNotice({ e: { models: [], status: { kind: "unsupported" }, type: "baseten" } })).toBe(false);
    expect(reportNeedsNotice({ e: { models: [], status: { kind: "cached", ageHours: 1 }, type: "anatropic" } })).toBe(false);
    expect(reportNeedsNotice({})).toBe(false);
  });
});
