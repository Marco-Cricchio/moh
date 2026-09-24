import { describe, expect, test } from "bun:test";
import {
  buildCatalog,
  buildManifest,
  buildReport,
  coverageOf,
  hasNonzeroPricing,
  migrateOverrides,
  modelsDevPricing,
  openRouterPricing,
  projectModalities,
  type AggregatorSnapshots,
  type CatalogOverrides,
} from "../src/model-catalog-build";

const md = (models: Record<string, unknown>) => ({ models: models as never });
const snapshots = (options: {
  modelsDev?: Record<string, unknown>;
  openRouter?: unknown[];
}): AggregatorSnapshots => ({
  modelsDev: (options.modelsDev ?? {}) as never,
  openRouter: { data: (options.openRouter ?? []) as never },
});

const sidecar = (overrides: Partial<CatalogOverrides> = {}): CatalogOverrides => ({
  schemaVersion: 1,
  provider: "demo",
  source: { modelsDev: ["demo"] },
  file: { provider: "demo", baseUrl: "https://api.demo.example/v1" },
  rows: {},
  ...overrides,
});

const row = (extra: Record<string, unknown> = {}) => ({
  author: "moh migration (#959)",
  date: "2026-09-24",
  reason: "test row",
  api: "openai-completions",
  name: "Demo Model",
  ...extra,
});

describe("#959 unit conversions", () => {
  test("models.dev cost is USD/1M with snake_case cache keys and structured tiers", () => {
    expect(
      modelsDevPricing({
        input: 2.5,
        output: 15,
        cache_read: 0.25,
        cache_write: 0,
        tiers: [
          { input: 5, output: 22.5, cache_read: 0.5, tier: { type: "context", size: 272000 } },
          // a non-context tier is not convertible: skipped, never guessed
          { input: 1, output: 1, tier: { type: "throughput", size: 10 } },
        ],
      }),
    ).toEqual({
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 272000, input: 5, output: 22.5, cacheRead: 0.5 }],
    });
    expect(modelsDevPricing(undefined)).toBeUndefined();
  });

  test("OpenRouter pricing is USD/token as strings: ×1e6, string→number, no float dust", () => {
    expect(
      openRouterPricing({
        prompt: "0.0000002",
        completion: "0.0000012",
        input_cache_read: "0.00000002",
        input_cache_write: "0.00000025",
      }),
    ).toEqual({ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 });
    // a non-numeric rate is unknown, never "free"
    expect(openRouterPricing({ prompt: "not-a-number" })).toBeUndefined();
    expect(openRouterPricing(undefined)).toBeUndefined();
  });

  test("input modalities are projected onto moh's vocabulary", () => {
    expect(projectModalities(["text", "image", "pdf", "video"])).toEqual(["text", "image"]);
    expect(projectModalities(["pdf"])).toBeUndefined();
    expect(projectModalities(undefined)).toBeUndefined();
  });
});

describe("#959 join precedence", () => {
  const model = { id: "demo-1", cost: { input: 1, output: 2 }, limit: { context: 100, output: 10 } };

  test("models.dev wins over OpenRouter when both cover the row", () => {
    const built = buildCatalog(
      sidecar({ rows: { "demo-1": row() } }),
      snapshots({
        modelsDev: { demo: md({ "demo-1": model }) },
        openRouter: [{ id: "demo/demo-1", pricing: { prompt: "0.00001", completion: "0.00002" }, context_length: 500 }],
      }),
    );
    expect(built.rows["demo-1"]).toMatchObject({ verdict: "exact", source: "models.dev", namespace: "demo" });
    expect(built.file["openai-completions"]!["demo-1"]!.cost).toEqual({ input: 1, output: 2 });
    expect(built.file["openai-completions"]!["demo-1"]!.contextWindow).toBe(100);
    expect(built.crossSourceContextDiffs).toEqual([{ id: "demo-1", modelsDev: 100, openRouter: 500 }]);
  });

  test("a declared vendor prefix matches the namespaced id", () => {
    const built = buildCatalog(
      sidecar({ source: { openRouter: ["demo"] }, rows: { "demo-1": row() } }),
      snapshots({ openRouter: [{ id: "demo/demo-1", pricing: { prompt: "0.00001", completion: "0.00002" }, context_length: 500 }] }),
    );
    expect(built.rows["demo-1"]).toMatchObject({ verdict: "base-model", source: "openrouter", namespace: "demo/demo-1" });
    expect(built.file["openai-completions"]!["demo-1"]!.cost).toEqual({ input: 10, output: 20 });
    expect(built.file["openai-completions"]!["demo-1"]!.contextWindow).toBe(500);
    // OpenRouter declares no output limit: maxTokens stays hand-maintained
    expect(built.file["openai-completions"]!["demo-1"]!.maxTokens).toBeUndefined();
  });

  test("the namespaced join finds any vendor whose model part is the row id", () => {
    const built = buildCatalog(
      sidecar({ rows: { "demo-1": row() } }),
      snapshots({ openRouter: [{ id: "someone-else/demo-1", context_length: 42 }] }),
    );
    expect(built.rows["demo-1"]!.verdict).toBe("base-model");
    expect(built.file["openai-completions"]!["demo-1"]!.contextWindow).toBe(42);
  });

  test("several OpenRouter candidates are ambiguous: nothing is guessed", () => {
    const built = buildCatalog(
      sidecar({ rows: { "demo-1": row({ contextWindow: 7 }) } }),
      snapshots({ openRouter: [{ id: "a/demo-1", context_length: 1 }, { id: "b/demo-1", context_length: 2 }] }),
    );
    expect(built.rows["demo-1"]!.verdict).toBe("absent");
    expect(built.file["openai-completions"]!["demo-1"]!.contextWindow).toBe(7);
    expect(built.issues.map((i) => i.code)).toContain("ambiguous-openrouter-match");
  });

  test("a models.dev base_model record supplies a row reached by no exact id", () => {
    const built = buildCatalog(
      sidecar({ rows: { "demo-1": row() } }),
      snapshots({ modelsDev: { demo: md({ "demo-1-latest": { ...model, id: "demo-1-latest", base_model: "demo-1" } }) } }),
    );
    expect(built.rows["demo-1"]).toMatchObject({ verdict: "base-model", source: "models.dev" });
    expect(built.file["openai-completions"]!["demo-1"]!.cost).toEqual({ input: 1, output: 2 });
  });

  test("a row two records of ONE source price differently is reported ambiguous", () => {
    // The census's ambiguity test (#953): the metered namespace and the plan
    // namespace are both models.dev, and they disagree (the five zai rows).
    // The declared precedence still decides the value (ADR-0046); the verdict
    // says the choice came from the declaration, not from the data.
    const built = buildCatalog(
      sidecar({ source: { modelsDev: ["demo"], plan: { modelsDev: ["demo-plan"] } }, rows: { "demo-1": row() } }),
      snapshots({
        modelsDev: {
          demo: md({ "demo-1": { id: "demo-1", cost: { input: 1, output: 2 }, limit: { context: 100 } } }),
          "demo-plan": md({ "demo-1": { id: "demo-1", cost: { input: 9, output: 9 }, limit: { context: 100 } } }),
        },
      }),
    );
    expect(built.rows["demo-1"]!.verdict).toBe("ambiguous");
    expect(built.rows["demo-1"]!.plan).toEqual({ source: "models.dev", namespace: "demo-plan" });
    expect(built.file["openai-completions"]!["demo-1"]!.cost).toEqual({ input: 1, output: 2 });
    expect(built.file["openai-completions"]!["demo-1"]!.planCost).toEqual({ input: 9, output: 9 });
    expect(built.verdicts.ambiguous).toBe(1);
  });

  test("cross-source disagreement is a difference, not a conflict", () => {
    // models.dev wins by declaration; the OpenRouter value is recorded, and
    // the row is not called ambiguous (the census's own rule, #953).
    const built = buildCatalog(
      sidecar({ rows: { "demo-1": row() } }),
      snapshots({
        modelsDev: { demo: md({ "demo-1": { id: "demo-1", cost: { input: 1, output: 2 }, limit: { context: 100 } } }) },
        openRouter: [{ id: "demo/demo-1", pricing: { prompt: "0.00001", completion: "0.00002" }, context_length: 500 }],
      }),
    );
    expect(built.rows["demo-1"]!.verdict).toBe("exact");
    expect(built.verdicts.ambiguous).toBe(0);
    expect(built.crossSourceContextDiffs).toEqual([{ id: "demo-1", modelsDev: 100, openRouter: 500 }]);
  });

  test("namespaces are searched in declared order", () => {
    const built = buildCatalog(
      sidecar({ source: { modelsDev: ["plan", "api"] }, rows: { "demo-1": row() } }),
      snapshots({ modelsDev: { api: md({ "demo-1": model }), plan: md({ "demo-1": { ...model, cost: { input: 9, output: 9 } } }) } }),
    );
    expect(built.rows["demo-1"]!.namespace).toBe("plan");
    expect(built.file["openai-completions"]!["demo-1"]!.cost).toEqual({ input: 9, output: 9 });
  });
});

describe("#959 overrides", () => {
  test("an override wins over the aggregator, field by field", () => {
    const built = buildCatalog(
      sidecar({
        rows: {
          "demo-1": row({
            cost: { input: 3, output: 4 },
            contextWindow: 999,
            compat: { thinkingFormat: "openai" },
            thinkingLevelMap: { off: null, low: "low" },
            headers: { "editor-version": "v1" },
          }),
        },
      }),
      snapshots({
        modelsDev: {
          demo: md({
            "demo-1": { id: "demo-1", name: "Upstream Label", cost: { input: 1, output: 2 }, limit: { context: 100, output: 10 }, reasoning: true, modalities: { input: ["text", "image", "pdf"] } },
          }),
        },
      }),
    );
    const written = built.file["openai-completions"]!["demo-1"]!;
    expect(written.cost).toEqual({ input: 3, output: 4 });
    expect(written.contextWindow).toBe(999);
    // moh-owned fields are never aggregator-supplied
    expect(written.name).toBe("Demo Model");
    expect(written.provider).toBe("demo");
    expect(written.baseUrl).toBe("https://api.demo.example/v1");
    expect(written.compat).toEqual({ thinkingFormat: "openai" });
    expect(written.thinkingLevelMap).toEqual({ off: null, low: "low" });
    expect(written.headers).toEqual({ "editor-version": "v1" });
    // aggregator-supplied fields the override did not touch stay refreshed
    expect(written.reasoning).toBe(true);
    expect(written.input).toEqual(["text", "image"]);
    expect(written.maxTokens).toBe(10);
    // provenance lists the value fields the sidecar declared; row identity
    // and labels (api, name, compat…) are declarations, not provenance
    expect(built.rows["demo-1"]!.overrides).toEqual(["cost", "contextWindow"]);
  });

  test("a declared plan namespace supplies planCost beside the metered cost", () => {
    const built = buildCatalog(
      sidecar({ source: { modelsDev: ["demo"], plan: { modelsDev: ["demo-plan"] } }, rows: { "demo-1": row() } }),
      snapshots({
        modelsDev: {
          demo: md({ "demo-1": { id: "demo-1", cost: { input: 1.4, output: 4.4 } } }),
          "demo-plan": md({ "demo-1": { id: "demo-1", cost: { input: 0, output: 0 } } }),
        },
      }),
    );
    const written = built.file["openai-completions"]!["demo-1"]!;
    expect(written.cost).toEqual({ input: 1.4, output: 4.4 });
    expect(written.planCost).toEqual({ input: 0, output: 0 });
    expect(built.rows["demo-1"]!.plan).toEqual({ source: "models.dev", namespace: "demo-plan" });
    // zero-only plan entries are placeholders, not evidence of a free rate
    expect(hasNonzeroPricing(written.planCost)).toBe(false);
  });

  test("the row is filed under the api the sidecar declares", () => {
    const built = buildCatalog(
      sidecar({ rows: { "demo-1": row({ api: "anthropic-messages" }), "demo-2": row() } }),
      snapshots({ modelsDev: { demo: md({}) } }),
    );
    expect(Object.keys(built.file)).toEqual(["anthropic-messages", "openai-completions"]);
    expect(built.file["anthropic-messages"]!["demo-1"]!.api).toBe("anthropic-messages");
  });

  test("the same input builds the same bytes (determinism)", () => {
    const build = () =>
      buildCatalog(
        sidecar({ rows: { "demo-1": row({ compat: { a: 1 } }), "demo-2": row({ cost: { input: 1, output: 1 } }) } }),
        snapshots({ modelsDev: { demo: md({ "demo-1": { id: "demo-1", cost: { input: 1, output: 2 } } }) } }),
      ).json;
    expect(build()).toBe(build());
  });
});

describe("#959 guards", () => {
  const previous = { "openai-completions": { "demo-1": { id: "demo-1", cost: { input: 1, output: 2 }, contextWindow: 100 } } };

  test("a committed row the sidecar does not declare fails generation", () => {
    const built = buildCatalog(sidecar({ rows: { "demo-2": row() } }), snapshots({}), { previous });
    expect(built.issues.map((i) => i.code)).toContain("row-not-declared");
  });

  test("a shrinking contextWindow fails generation unless the sidecar declares it", () => {
    const upstream = snapshots({ modelsDev: { demo: md({ "demo-1": { id: "demo-1", cost: { input: 1, output: 2 }, limit: { context: 50 } } }) } });
    const silent = buildCatalog(sidecar({ rows: { "demo-1": row() } }), upstream, { previous });
    expect(silent.issues.find((i) => i.code === "context-window-regression")?.level).toBe("error");

    const declared = buildCatalog(sidecar({ rows: { "demo-1": row({ contextWindow: 50 }) } }), upstream, { previous });
    expect(declared.issues).toEqual([]);
    expect(declared.file["openai-completions"]!["demo-1"]!.contextWindow).toBe(50);
  });

  test("losing a metered price fails generation unless the sidecar declares it", () => {
    const upstream = snapshots({ modelsDev: { demo: md({ "demo-1": { id: "demo-1", cost: { input: 0, output: 0 }, limit: { context: 100 } } }) } });
    const silent = buildCatalog(sidecar({ rows: { "demo-1": row() } }), upstream, { previous });
    expect(silent.issues.map((i) => i.code)).toContain("pricing-coverage-drop");

    const declared = buildCatalog(sidecar({ rows: { "demo-1": row({ cost: { input: 1, output: 2 } }) } }), upstream, { previous });
    expect(declared.issues).toEqual([]);
    expect(declared.file["openai-completions"]!["demo-1"]!.cost).toEqual({ input: 1, output: 2 });
  });

  test("row ids stay unique across the api groups of one catalog", () => {
    const built = buildCatalog(
      sidecar({ rows: { "demo-1": row({ api: "anthropic-messages" }), "demo-2": row({ api: "openai-completions" }) } }),
      snapshots({}),
    );
    expect(built.issues.some((i) => i.level === "error")).toBe(false);
    expect(Object.keys(built.file)).toEqual(["anthropic-messages", "openai-completions"]);
  });
});

describe("#959 migration (committed catalog → sidecar)", () => {
  const stamp = { author: "moh migration (#959)", date: "2026-09-24" };

  test("a covered row keeps its labels and lets the aggregator supply the value fields", () => {
    const { overrides, notes } = migrateOverrides({
      provider: "demo",
      source: { modelsDev: ["demo"] },
      previous: {
        "openai-completions": {
          "demo-1": { id: "demo-1", name: "Demo One", api: "openai-completions", provider: "demo", baseUrl: "https://api.demo.example/v1", reasoning: true, input: ["text"], cost: { input: 1, output: 2 }, contextWindow: 100, maxTokens: 10, compat: { a: 1 } },
        },
      },
      snapshots: snapshots({ modelsDev: { demo: md({ "demo-1": { id: "demo-1", cost: { input: 3, output: 4 }, limit: { context: 100, output: 10 }, reasoning: true, modalities: { input: ["text", "pdf"] } } }) } }),
      stamp,
    });
    const row = overrides.rows["demo-1"]!;
    expect(overrides.file).toEqual({ api: "openai-completions", provider: "demo", baseUrl: "https://api.demo.example/v1" });
    expect(row.name).toBe("Demo One");
    expect(row.compat).toEqual({ a: 1 });
    // the aggregator refreshes cost/context/maxTokens/reasoning/input
    expect(row.cost).toBeUndefined();
    expect(row.contextWindow).toBeUndefined();
    expect(row.input).toBeUndefined();
    expect(notes).toEqual([]);
  });

  test("an absent row is carried whole, and gets a label", () => {
    const { overrides, notes } = migrateOverrides({
      provider: "demo",
      source: { modelsDev: ["demo"] },
      previous: { "openai-completions": { "demo-x": { id: "demo-x", name: "Demo X", api: "openai-completions", cost: { input: 1, output: 2 }, contextWindow: 100 } } },
      snapshots: snapshots({ modelsDev: { demo: md({}) } }),
      stamp,
    });
    const row = overrides.rows["demo-x"]!;
    expect(row).toMatchObject({ name: "Demo X", cost: { input: 1, output: 2 }, contextWindow: 100 });
    expect(row.reason).toContain("no aggregator record");
    expect(notes.map((n) => n.code)).toEqual(["absent-row"]);
  });

  test("a field the aggregators cannot supply is carried with its reason", () => {
    const { overrides, notes } = migrateOverrides({
      provider: "demo",
      source: { openRouter: ["demo"] },
      previous: { "openai-completions": { "demo-1": { id: "demo-1", api: "openai-completions", cost: { input: 1, output: 2 }, contextWindow: 100, maxTokens: 10 } } },
      snapshots: snapshots({ openRouter: [{ id: "demo/demo-1", pricing: { prompt: "0.000001", completion: "0.000002" }, context_length: 100 }] }),
      stamp,
    });
    const row = overrides.rows["demo-1"]!;
    expect(row.maxTokens).toBe(10);
    expect(row.cost).toBeUndefined();
    expect(notes.map((n) => n.code)).toEqual(["field-carried"]);
    expect(notes[0]!.message).toContain("maxTokens");
  });

  test("a zero-only upstream rate does not drop the committed metered price", () => {
    const { overrides, notes } = migrateOverrides({
      provider: "demo",
      source: { modelsDev: ["demo"], plan: { modelsDev: ["demo-plan"] } },
      previous: { "openai-completions": { "demo-1": { id: "demo-1", api: "openai-completions", cost: { input: 3, output: 15 }, contextWindow: 100 } } },
      snapshots: snapshots({ modelsDev: { demo: md({ "demo-1": { id: "demo-1", cost: { input: 0, output: 0 }, limit: { context: 100 } } }), "demo-plan": md({ "demo-1": { id: "demo-1", cost: { input: 0, output: 0 } } }) } }),
      stamp,
    });
    expect(overrides.rows["demo-1"]!.cost).toEqual({ input: 3, output: 15 });
    expect(notes.map((n) => n.code)).toEqual(["metered-rate-kept"]);
  });

  test("an upstream window smaller than the committed one is accepted explicitly", () => {
    const { overrides, notes } = migrateOverrides({
      provider: "demo",
      source: { modelsDev: ["demo"] },
      previous: { "openai-completions": { "demo-1": { id: "demo-1", api: "openai-completions", contextWindow: 1000000 } } },
      snapshots: snapshots({ modelsDev: { demo: md({ "demo-1": { id: "demo-1", limit: { context: 200000 } } }) } }),
      stamp,
    });
    expect(overrides.rows["demo-1"]!.acceptContextShrink).toBe(true);
    expect(notes.map((n) => n.code)).toEqual(["context-shrink-accepted"]);
  });

  test("the migrated sidecar reproduces the committed data through one generation", () => {
    const previous = {
      "openai-completions": {
        "demo-1": { id: "demo-1", name: "Demo One", api: "openai-completions", provider: "demo", baseUrl: "https://api.demo.example/v1", reasoning: true, input: ["text"], cost: { input: 1, output: 2 }, contextWindow: 100, maxTokens: 10, compat: { a: 1 } },
        "demo-2": { id: "demo-2", name: "Demo Two", api: "openai-completions", provider: "demo", baseUrl: "https://api.demo.example/v1", cost: { input: 0, output: 0 }, contextWindow: 50, maxTokens: 5 },
      },
    };
    const snap = snapshots({
      modelsDev: {
        demo: md({
          "demo-1": { id: "demo-1", cost: { input: 1, output: 2 }, limit: { context: 100, output: 10 }, reasoning: true, modalities: { input: ["text"] } },
        }),
      },
    });
    const { overrides } = migrateOverrides({ provider: "demo", source: { modelsDev: ["demo"] }, previous, snapshots: snap, stamp });
    const built = buildCatalog(overrides, snap, { previous });
    expect(built.issues).toEqual([]);
    expect(built.file).toEqual(previous);
  });
});

describe("#959 manifest and report", () => {
  test("the manifest records per-file hashes, verdicts and per-row provenance", () => {
    const built = buildCatalog(
      sidecar({ rows: { "demo-1": row({ compat: { a: 1 } }), "demo-2": row({ cost: { input: 1, output: 1 } }) } }),
      snapshots({ modelsDev: { demo: md({ "demo-1": { id: "demo-1", cost: { input: 1, output: 2 }, limit: { context: 5 } } }) } }),
    );
    const manifest = buildManifest({
      version: "0.50.0",
      generatedAt: "2026-09-24T00:00:00.000Z",
      sources: [{ name: "models.dev", url: "https://models.dev/api.json", fetchedAt: "2026-09-24T00:00:00.000Z" }],
      catalogs: [built],
      hashes: { demo: "abc" },
    });
    expect(manifest.files.demo).toEqual({ sha256: "abc", rows: 2, verdicts: { exact: 1, "base-model": 0, ambiguous: 0, absent: 1 } });
    expect(manifest.rows["demo/demo-1"]).toMatchObject({ provider: "demo", id: "demo-1", verdict: "exact", supplied: ["cost", "contextWindow"], overrides: [] });
    expect(manifest.rows["demo/demo-2"]).toMatchObject({ verdict: "absent", supplied: [], overrides: ["cost"] });
  });

  test("the report carries coverage deltas, absent ids and shrinks", () => {
    const built = buildCatalog(
      sidecar({ rows: { "demo-1": row({ acceptContextShrink: true }), "demo-2": row() } }),
      snapshots({ modelsDev: { demo: md({ "demo-1": { id: "demo-1", cost: { input: 1, output: 2 }, limit: { context: 50 } } }) } }),
    );
    const report = buildReport({
      version: "0.50.0",
      generatedAt: "2026-09-24T00:00:00.000Z",
      sources: [],
      catalogs: [built],
      previous: { demo: { "openai-completions": { "demo-1": { id: "demo-1", cost: { input: 1, output: 2 }, contextWindow: 100 } } } },
    });
    expect(report.totals).toEqual({ files: 1, rows: 2, exact: 1, baseModel: 0, ambiguous: 0, absent: 1, rowsWithOverrides: 0 });
    expect(report.absentIds).toEqual(["demo/demo-2"]);
    expect(report.contextWindowShrinks).toEqual([{ provider: "demo", id: "demo-1", from: 100, to: 50, declared: true }]);
    expect(report.files[0]!.previous).toEqual({ rows: 1, pricing: 1, contextWindow: 1, maxTokens: 0, reasoning: 0, input: 0 });
    expect(report.changes.contextWindow).toEqual([{ provider: "demo", id: "demo-1", from: 100, to: 50 }]);
  });

  test("coverage counts a plan entry as pricing, zero-only entries as none", () => {
    expect(
      coverageOf({
        api: {
          a: { id: "a", cost: { input: 0, output: 0 } },
          b: { id: "b", planCost: { input: 1, output: 1 } },
          c: { id: "c", cost: { input: 0, output: 0, tiers: [{ inputTokensAbove: 1, input: 2, output: 3 }] } },
        },
      }),
    ).toEqual({ rows: 3, pricing: 2, contextWindow: 0, maxTokens: 0, reasoning: 0, input: 0 });
  });
});
