/**
 * #1032 / ADR-0049 door two: the window the endpoint itself reports —
 * its own cached listing — is the one moh uses, and the lookup is keyed
 * by the endpoint, not the provider kind.
 */
import { describe, expect, test } from "bun:test";
import { CompactionRunner, contextWindowFor } from "../src/compaction";
import type { AgentEvent, Provider } from "../src/types";
import { declaredWindowsFor, type LiveModelCacheEntry } from "../src/live-model-catalog";
import { catalogEntryFor, endpointModelCatalog } from "../src/model-catalog";
import { contextFitFor } from "../src/context-fit";

/** Two `user_message` events with a `model_call` measurement on the first. */
function turnEvents(turn: number, inputTokens: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (let t = 0; t <= turn; t++) {
    events.push({ type: "user_message", text: `turn ${t}` } as AgentEvent);
    if (t < turn) {
      events.push({ type: "model_call", model: "openai/gpt-5.5", usage: { inputTokens, outputTokens: 0 } } as AgentEvent);
    }
  }
  return events;
}

describe("#1032 endpoint-keyed lookup", () => {
  test("the opencode Go endpoint resolves its OWN catalog row (1,000,000, not 0)", () => {
    const window = contextWindowFor("opencode-go/deepseek-v4.1-flash", {
      type: "opencode",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    expect(window).toBe(1_000_000);
  });

  test("Zen does not read Go's rows, and Go does not read Zen's", () => {
    // deepseek-v4.1-flash ships only in opencode-go.json.
    expect(catalogEntryFor("opencode", "deepseek-v4.1-flash")).toBeUndefined();
    expect(
      contextWindowFor("opencode-zen/deepseek-v4.1-flash", { type: "opencode", baseUrl: "https://opencode.ai/zen/v1" }),
    ).toBe(0);
  });

  test("an openai-compat endpoint with a known base URL resolves that catalog (zai)", () => {
    const window = contextWindowFor("zai/glm-5.2", {
      type: "openai-compat",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
    });
    expect(window).toBe(endpointModelCatalog("openai-compat", "https://api.z.ai/api/coding/paas/v4").find((m) => m.id === "glm-5.2")!.contextWindow);
    expect(window).toBeGreaterThan(0);
  });

  test("a model with no listing and no shipped row still reads 0 (unknown)", () => {
    expect(contextWindowFor("mock/some-model", { type: "mock", declaredWindows: {} })).toBe(0);
    expect(contextWindowFor("anthropic/claude-sonnet-4-5", undefined)).toBe(0);
  });

  test("the legacy string form still resolves by provider kind", () => {
    expect(contextWindowFor("anthropic/claude-haiku-4-5", "anthropic")).toBe(200_000);
  });
});

describe("#1032 the endpoint's listing outranks the shipped row (both directions)", () => {
  const listing = (contextWindow: number): Record<string, number> => ({ "gpt-5.5": contextWindow });

  test("a SMALLER declared window is adopted (the measured #1032 case: 272,000 against a shipped 1,050,000)", () => {
    expect(contextWindowFor("openai/gpt-5.5", { type: "openai", declaredWindows: listing(272_000) })).toBe(272_000);
  });

  test("a LARGER declared window is adopted too", () => {
    expect(contextWindowFor("anthropic/claude-haiku-4-5", { type: "anthropic", declaredWindows: { "claude-haiku-4-5": 500_000 } })).toBe(500_000);
  });

  test("without a declaration the shipped row stands", () => {
    expect(contextWindowFor("openai/gpt-5.5", { type: "openai", declaredWindows: {} })).toBe(272_000);
    expect(contextWindowFor("openai/gpt-5.5", { type: "openai" })).toBe(272_000);
  });

  test("a declared 0 or negative value is not a declaration", () => {
    expect(contextWindowFor("openai/gpt-5.5", { type: "openai", declaredWindows: { "gpt-5.5": 0 } })).toBe(272_000);
  });

  test("the compaction auto-trigger arms on the declared number, not the shipped row (#1032 measured case)", () => {
    // 0.8 × 272,000 = 217,600 — the shipped row's 840,000 threshold would
    // let the session run far past what the endpoint serves.
    const r = new CompactionRunner({
      sessionId: "session-test",
      provider: () => ({ name: "openai/gpt-5.5" } as unknown as Provider),
      endpoint: () => ({ type: "openai", declaredWindows: { "gpt-5.5": 272_000 } }),
      append: () => {},
      onCompacted: () => {},
      summarizer: async () => "SUMMARY",
    });
    expect(r.shouldAutoCompact(turnEvents(1, 220_000))).toBe(true);
    expect(r.shouldAutoCompact(turnEvents(1, 215_000))).toBe(false);
  });
});

describe("#1032 the shipped Codex rows carry the provider's number", () => {
  test("openai-codex rows the provider lists at 272,000 ship 272,000", () => {
    for (const id of ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      expect(catalogEntryFor("openai", id)?.contextWindow, id).toBe(272_000);
    }
  });
});

describe("#1032 declaredWindowsFor (the cache projection)", () => {
  const entry = (models: { id: string; contextWindow?: number }[], fetchedAt = Date.now()): LiveModelCacheEntry => ({
    fetchedAt,
    models: models.map((m) => ({ id: m.id, ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}) })),
  });

  test("an entry — fresh, cached or stale, indistinguishable on disk — contributes its windows", () => {
    const cache: Record<string, LiveModelCacheEntry> = {
      fresh: entry([{ id: "a", contextWindow: 1 }, { id: "b" }]),
      stale: entry([{ id: "a", contextWindow: 2 }], Date.now() - 100 * 3_600_000),
    };
    expect(declaredWindowsFor("fresh", cache)).toEqual({ a: 1 });
    expect(declaredWindowsFor("stale", cache)).toEqual({ a: 2 });
  });

  test("no entry (failed refresh, unsupported kind) contributes nothing", () => {
    expect(declaredWindowsFor("missing", {})).toEqual({});
    expect(declaredWindowsFor("missing", { other: entry([{ id: "a", contextWindow: 1 }]) })).toEqual({});
  });

  test("a listing that carries ids only contributes nothing", () => {
    expect(declaredWindowsFor("ids-only", { "ids-only": entry([{ id: "a" }, { id: "b" }]) })).toEqual({});
  });
});

describe("#1032 consumers route through the one lookup", () => {
  test("the fit guard refuses a switch the declared window cannot hold", () => {
    // 270k measured does not fit 272k − 8k reserve (263,808), though it fit the shipped 1,050k.
    expect(contextFitFor({ measured: 270_000, window: 272_000 }).fits).toBe(false);
    expect(contextFitFor({ measured: 270_000, window: 1_050_000 }).fits).toBe(true);
  });
});
