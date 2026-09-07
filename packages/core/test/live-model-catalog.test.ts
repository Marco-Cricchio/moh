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
  type LiveModelListing,
} from "../src/live-model-catalog";
import type { CatalogModel } from "../src/model-catalog";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const vendored: CatalogModel[] = [
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
    expect(parseModelsResponse({ data: [] })).toBeUndefined();
    expect(parseModelsResponse(null)).toBeUndefined();
    expect(parseModelsResponse({ data: [{ nope: true }] })).toBeUndefined();
  });
});

describe("mergeLiveCatalog", () => {
  test("vendored wins on id collision; fetched-only are conservative rows", () => {
    const live: LiveModelListing[] = [
      { id: "claude-sonnet-4-5", name: "Impostor", contextWindow: 1 },
      { id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 300_000 },
      { id: "claude-unknown" },
    ];
    const merged = mergeLiveCatalog(vendored, live);
    expect(merged).toEqual([
      ...vendored,
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
      expect(out).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serves from a fresh cache without fetching; merges new fetches into the cache", async () => {
    const dir = home();
    try {
      const fetchImpl = async () => ({
        status: 200,
        json: { data: [{ id: "brand-new-model", display_name: "Brand New" }] },
      });
      const first = await fetchLiveCatalogs([{ name: "my-anthropic", type: "anthropic" }], { mohHome: dir, fetchImpl });
      expect(first["my-anthropic"]).toEqual([{ id: "brand-new-model", name: "Brand New" }]);

      // Second call within TTL: served from cache, fetch never invoked.
      let called = false;
      const countingFetch = async () => {
        called = true;
        return { status: 200, json: { data: [{ id: "brand-new-model", display_name: "Brand New" }] } };
      };
      const second = await fetchLiveCatalogs([{ name: "my-anthropic", type: "anthropic" }], { mohHome: dir, fetchImpl: countingFetch });
      expect(called).toBe(false);
      expect(second["my-anthropic"]).toEqual([{ id: "brand-new-model", name: "Brand New" }]);

      // force bypasses the cache and re-fetches.
      const forced = await fetchLiveCatalogs([{ name: "my-anthropic", type: "anthropic" }], { mohHome: dir, fetchImpl: countingFetch, force: true });
      expect(called).toBe(true);
      expect(forced["my-anthropic"].length).toBe(1);
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
      expect(out["my-xai"]).toEqual([{ id: "stale-grok" }]);
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
      expect(out["good"]).toEqual([{ id: "grok-5" }]);
      expect(out["bad"]).toBeUndefined();
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

  test("kimi-coding and zai have no verified contract and are never fetched", async () => {
    let called = false;
    const fail = async () => {
      called = true;
      return { status: 200, json: { data: [] } };
    };
    expect(listProviderModels("kimi-coding", "e", { fetchImpl: fail })).rejects.toThrow("no verified");
    expect(listProviderModels("zai", "e", { fetchImpl: fail })).rejects.toThrow("no verified");
    expect(called).toBe(false);
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

  test("throws on no verified contract (kimi-coding, zai)", async () => {
    expect(listProviderModels("kimi-coding", "e")).rejects.toThrow("no verified");
    expect(listProviderModels("zai", "e")).rejects.toThrow("no verified");
  });

  test("throws on HTTP failure and on unrecognized shape", async () => {
    expect(listProviderModels("anthropic", "e", { fetchImpl: async () => ({ status: 401, json: {} }) })).rejects.toThrow("HTTP 401");
    expect(listProviderModels("anthropic", "e", { fetchImpl: async () => ({ status: 200, json: { nope: [] } }) })).rejects.toThrow("unrecognized");
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