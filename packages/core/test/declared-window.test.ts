/**
 * ADR-0049 door one (#986): the context window a provider declares in its
 * own overflow refusal is used — for the compaction threshold, the tail
 * cut ceiling, the switch guard and the fallback chain — keyed by the
 * model reference that was refused, for the lifetime of the session, and
 * never reaching provider context.
 *
 * Every recognition formula is pinned here by the **real** provider
 * wording it was derived from (with its source); a formula nobody has
 * seen a real refusal for is not shipped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, createSession } from "../src/index";
import { normalizeProviderError } from "../src/provider-errors";
import { DeclaredWindows, DECLARED_WINDOW_FORMULAS, recognizeDeclaredWindow } from "../src/declared-window";
import { CompactionRunner, contextWindowFor, type CompactionSummarizer } from "../src/compaction";
import { fallbackIneligibleReason } from "../src/provider-registry";
import {
  CONTEXT_REFUSAL_EXCERPT_CHARS,
  CONTEXT_REFUSAL_MAX_ENTRIES,
  contextRefusalsFile,
  noteUnrecognizedContextRefusal,
} from "../src/context-refusal-trace";
import { ProviderError, type AgentEvent, type Provider, type ProviderErrorKind, type StreamEvent } from "../src/types";
import type { EndpointProfile, MohConfig } from "../src/config";

const TMP = join(import.meta.dir, "tmp-declared-window");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function home(): string {
  const dir = join(TMP, `home-${Math.random().toString(36).slice(2)}`);
  return dir;
}

/** The refusal quoted verbatim in #986 / ADR-0049, thrown by the endpoint
 * that motivated the issue (openrouter, 2026-09-23). */
const OPENROUTER_REFUSAL =
  "This endpoint's maximum context length is 131072 tokens. However, you requested about 234666 tokens (232641 of text input, 2025 of tool input).";

/** A refusal moh has not been taught to read: it names the failure
 * ("context length", so today's classification is unchanged — it is a
 * real refusal) but states no window in any shipped formula. */
const UNRECOGNIZED_REFUSAL = "This request exceeds the model's maximum context length";

/** A second, different window from the same endpoint family. */
const OTHER_REFUSAL = "This endpoint's maximum context length is 65536 tokens. However, you requested about 234666 tokens.";

/** A raw provider failure as an SDK throws it: a status plus the
 * provider's own message, untruncated. */
function rawRefusal(message: string, statusCode = 400): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/**
 * A provider that fails its first call with a *raw* provider error pushed
 * through the real normalization path (exactly what the ai-sdk provider
 * does with an error part), then serves every later call with measurable
 * usage.
 */
function refusingProvider(raw: unknown, opts: { ref: string; inputTokens?: number }): Provider {
  let call = 0;
  return {
    name: opts.ref,
    async *stream(): AsyncIterable<StreamEvent> {
      if (call++ === 0) throw normalizeProviderError(raw);
      yield { type: "model_call_start", model: opts.ref };
      yield { type: "text_delta", text: "ok" };
      yield { type: "usage", inputTokens: opts.inputTokens ?? 1_000, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  };
}

function endpoints(...profiles: EndpointProfile[]): MohConfig["endpoints"] {
  return profiles;
}

/** The shape every core consumer takes for declared windows; an
 * `AgentSession` satisfies it directly (its `declaredWindowFor`). */
type DeclaredLookup = { declaredWindowFor(ref: string): number | undefined };

describe("recognition is conservative and pinned to real wordings", () => {
  test("the refusal this issue carries (OpenRouter, verbatim in #986)", () => {
    expect(recognizeDeclaredWindow(OPENROUTER_REFUSAL)).toBe(131_072);
  });

  test("the same sentence with OpenAI's \"model's\" (the family's classic 400)", () => {
    expect(
      recognizeDeclaredWindow("This model's maximum context length is 128000 tokens. However, you requested 234666 tokens."),
    ).toBe(128_000);
  });

  test("Anthropic's \"prompt is too long: N tokens > M maximum\"", () => {
    // Real wording: openclaw's failover corpus, row billing-context-prompt-token-count.
    expect(recognizeDeclaredWindow("prompt is too long: 208423 tokens > 200000 maximum")).toBe(200_000);
  });

  test("Moonshot/Kimi's \"model token limit: N (requested: M)\"", () => {
    // Real wording: openclaw's failover corpus, row billing-context-kimi-limit.
    expect(recognizeDeclaredWindow("Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)")).toBe(262_144);
  });

  test("llama.cpp/Lemonade's \"exceeds [the] available context size (N tokens)\"", () => {
    // Real wording: openclaw's failover corpus, rows patterns-context-llamacpp-*.
    expect(recognizeDeclaredWindow("request (130000 tokens) exceeds available context size (131072 tokens)")).toBe(131_072);
    expect(recognizeDeclaredWindow("request (66202 tokens) exceeds the available context size (65536 tokens), try increasing it")).toBe(65_536);
  });

  test("a number without its marker teaches nothing — never a guess", () => {
    // The requested count, a request id, a price: all present in real
    // refusals, none of them a window.
    expect(recognizeDeclaredWindow("you requested about 234666 tokens")).toBeUndefined();
    expect(recognizeDeclaredWindow("Request size exceeds model context window")).toBeUndefined();
    expect(recognizeDeclaredWindow("input length 14295 tokens exceeds the model limit")).toBeUndefined();
    expect(recognizeDeclaredWindow("This request exceeds the model's maximum context length")).toBeUndefined();
    expect(recognizeDeclaredWindow("429 rate limit, retry after 20")).toBeUndefined();
  });

  test("commas in the provider's number are the same number", () => {
    expect(recognizeDeclaredWindow("maximum context length is 1,048,576 tokens")).toBe(1_048_576);
  });

  test("only the marker's own number matches, not a later one", () => {
    expect(recognizeDeclaredWindow("The maximum context length is 131072 tokens (you sent 262144).")).toBe(131_072);
  });

  test("every shipped formula carries the real wording it was derived from", () => {
    for (const formula of DECLARED_WINDOW_FORMULAS) {
      expect(formula.source.length).toBeGreaterThan(80);
      expect(/https?:|openclaw|litellm|#986|ADR-0049|session/.test(formula.source)).toBe(true);
    }
  });
});

describe("normalizeProviderError (#986)", () => {
  test("extracts the window from the untruncated text, before the 300-char cap", () => {
    // A verbose refusal: the formula sits beyond the cap that bounds both
    // the classified body and the logged message.
    const padding = "x".repeat(400);
    const err = rawRefusal(`${padding} ${OPENROUTER_REFUSAL}`);
    const normalized = normalizeProviderError(err);
    expect(normalized.declaredWindow).toBe(131_072);
    // The cap itself is unchanged: the log still holds a bounded message.
    expect(normalized.message.length).toBeLessThanOrEqual(301);
    expect(normalized.message.endsWith("…")).toBe(true);
  });

  test("classifies a verbose refusal as context_length from the untruncated text (#1199)", () => {
    // The formula sits past the 300-character cap, so the bounded
    // body/message cannot prove the refusal — the classification reads the
    // untruncated text too, or the kind gate would silently drop a real
    // refusal whose window rides unrecognized.
    const padding = "x".repeat(400);
    const normalized = normalizeProviderError(rawRefusal(`${padding} ${OPENROUTER_REFUSAL}`));
    expect(normalized.kind).toBe("context_length");
    expect(normalized.declaredWindow).toBe(131_072);
  });

  test("reads a window out of a JSON body too", () => {
    const err = rawRefusal("invalid request", 400) as Error & { responseBody: string };
    err.responseBody = JSON.stringify({ error: { message: OPENROUTER_REFUSAL } });
    expect(normalizeProviderError(err).declaredWindow).toBe(131_072);
  });

  test("the kind classification: shipped-formula wordings are refusals (#1199)", () => {
    // The kind classifier keyword net misses the Anthropic/Moonshot/
    // llama.cpp wordings; #1199 makes a recognized window formula itself
    // refusal evidence at 400/422, so a real overflow in those wordings
    // stays `context_length` and reaches the session's learning hook.
    for (const [message, kind] of [
      [OPENROUTER_REFUSAL, "context_length"],
      ["too many tokens: input length 14295 tokens", "context_length"],
      ["prompt is too long: 208423 tokens > 200000 maximum", "context_length"],
      ["Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)", "context_length"],
      ["request (130000 tokens) exceeds available context size (131072 tokens)", "context_length"],
      ["input length 14295 tokens exceeds the model limit", "invalid_request"],
      ["invalid temperature", "invalid_request"],
    ] as [string, ProviderErrorKind][]) {
      expect(normalizeProviderError(rawRefusal(message)).kind).toBe(kind);
    }
  });

  test("a recognizable window inside a non-400/422 failure keeps that failure's kind", () => {
    // #1199: recognition never re-kinds a failure. A hostile or broken
    // upstream body naming a window inside a 5xx is `overloaded` — and,
    // gated on the kind, teaches nothing.
    const overloaded = normalizeProviderError(rawRefusal("Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)", 503));
    expect(overloaded.kind).toBe("overloaded");
    expect(overloaded.declaredWindow).toBe(262_144);
    const network = normalizeProviderError(rawRefusal("request (130000 tokens) exceeds available context size (131072 tokens)", 504));
    expect(network.kind).toBe("network");
    expect(network.declaredWindow).toBe(131_072);
  });

  test("no formula matched: the error carries no declared window", () => {
    expect(normalizeProviderError(rawRefusal("input length 14295 tokens exceeds the model limit")).declaredWindow).toBeUndefined();
  });
});

describe("capacity arithmetic and display never see provider text", () => {
  test("a refusal changes no message the provider receives", async () => {
    // Two sessions, the same two turns, the same text. One meets a refusal
    // (and learns a declared window), the other meets a classification-only
    // failure. The prompts the provider receives must be byte-for-byte the
    // same: the correction is chrome, and chrome is not context.
    const ref = "openrouter/x-ai/grok-4.20";
    async function run(firstCall: "refuse" | "fail"): Promise<{ seen: string[]; session: ReturnType<typeof createSession> }> {
      const seen: string[] = [];
      let call = 0;
      const provider: Provider = {
        name: ref,
        async *stream(messages): AsyncIterable<StreamEvent> {
          if (call++ === 0) {
            throw firstCall === "refuse"
              ? normalizeProviderError(rawRefusal(OPENROUTER_REFUSAL))
              : new ProviderError("invalid_request", "bad request");
          }
          seen.push(JSON.stringify(messages));
          yield { type: "text_delta", text: "ok" };
          yield { type: "finish", reason: "stop" };
        },
      };
      const session = createSession({
        provider,
        endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
        compaction: { enabled: false },
      });
      await session.send("hello");
      await session.send("again"); // the second call is the observable prompt
      return { seen, session };
    }

    const refused = await run("refuse");
    const control = await run("fail");
    expect(refused.session.history().some((e) => e.type === "declared_window")).toBe(true);
    expect(control.session.history().some((e) => e.type === "declared_window")).toBe(false);
    expect(refused.seen).toHaveLength(1);
    expect(refused.seen[0]).toBe(control.seen[0]);
  });
});

describe("a real refusal teaches the window, for the session", () => {
  test("a refusal that agrees with the catalog is a confirmation, never a log line", async () => {
    // The shipped openrouter row for mistral-nemo is 131,072 — the same
    // number the refusal declares. The log records corrections, not
    // confirmations: nothing is appended, and the effective window is
    // unchanged either way (the session computes the same numbers).
    const ref = "openrouter/mistralai/mistral-nemo";
    const session = createSession({
      provider: refusingProvider(rawRefusal(OPENROUTER_REFUSAL), { ref }),
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "mistralai/mistral-nemo" }),
      compaction: { enabled: false },
    });
    await session.send("merge");
    expect(session.history().some((e) => e.type === "declared_window")).toBe(false);
    expect(contextWindowFor(ref, "openrouter", session as DeclaredLookup)).toBe(131_072);
    // The failure itself is untouched: the same `context_length` error,
    // and (per #947) the same arming of the producer.
    expect(session.history().some((e) => e.type === "error" && e.reason === "context_length")).toBe(true);
  });

  test("an over-claiming catalog row is corrected (2,000,000 → refused 131,072)", async () => {
    const ref = "openrouter/x-ai/grok-4.20";
    const session = createSession({
      provider: refusingProvider(rawRefusal(OPENROUTER_REFUSAL), { ref }),
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
      compaction: { enabled: false },
    });
    expect(contextWindowFor(ref, "openrouter")).toBe(2_000_000);
    await session.send("merge");
    const learned = session.history().find((e) => e.type === "declared_window") as Extract<AgentEvent, { type: "declared_window" }>;
    expect(learned).toMatchObject({ window: 131_072, catalog: 2_000_000 });
    // The catalog itself is never edited (ADR-0046 owns it).
    expect(contextWindowFor(ref, "openrouter")).toBe(2_000_000);
    // The single lookup, with the session's declared windows, is corrected.
    expect(contextWindowFor(ref, "openrouter", session as DeclaredLookup)).toBe(131_072);
  });

  test("an under-claiming catalog row is corrected too (8,191 → refused 131,072)", async () => {
    const ref = "openrouter/openai/gpt-4";
    const session = createSession({
      provider: refusingProvider(rawRefusal(OPENROUTER_REFUSAL), { ref }),
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "openai/gpt-4" }),
      compaction: { enabled: false },
    });
    expect(contextWindowFor(ref, "openrouter")).toBe(8_191);
    await session.send("merge");
    const learned = session.history().find((e) => e.type === "declared_window") as Extract<AgentEvent, { type: "declared_window" }>;
    expect(learned).toMatchObject({ window: 131_072, catalog: 8_191 });
    expect(contextWindowFor(ref, "openrouter", session as DeclaredLookup)).toBe(131_072);
  });

  test("another model on the same endpoint keeps its catalog value (no inheritance)", async () => {
    const refused = "openrouter/x-ai/grok-4.20";
    const other = "openrouter/openai/gpt-4";
    const session = createSession({
      provider: refusingProvider(rawRefusal(OPENROUTER_REFUSAL), { ref: refused }),
      endpoints: endpoints(
        { name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" },
        { name: "openrouter", type: "openrouter", defaultModel: "openai/gpt-4" },
      ),
      compaction: { enabled: false },
    });
    await session.send("merge");
    expect(session.declaredWindowFor(refused)).toBe(131_072);
    expect(session.declaredWindowFor(other)).toBeUndefined();
    expect(contextWindowFor(other, "openrouter", session as DeclaredLookup)).toBe(8_191);
  });

  test("the same number again appends nothing; a different number is its own fact", async () => {
    const ref = "openrouter/x-ai/grok-4.20";
    const refusals = [OPENROUTER_REFUSAL, OPENROUTER_REFUSAL, OTHER_REFUSAL];
    let call = 0;
    const provider: Provider = {
      name: ref,
      async *stream(): AsyncIterable<StreamEvent> {
        const current = refusals[call];
        call += 1;
        if (current !== undefined) throw normalizeProviderError(rawRefusal(current));
        yield { type: "text_delta", text: "ok" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const session = createSession({
      provider,
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
      compaction: { enabled: false },
    });
    await session.send("one");
    await session.send("two"); // identical number: a confirmation, not a correction
    expect(session.history().filter((e) => e.type === "declared_window").length).toBe(1);
    await session.send("three"); // a different number: a new fact
    const learned = session.history().filter((e) => e.type === "declared_window") as Extract<AgentEvent, { type: "declared_window" }>[];
    expect(learned.length).toBe(2);
    expect(learned.map((e) => e.window)).toEqual([131_072, 65_536]);
    expect(session.declaredWindowFor(ref)).toBe(65_536);
  });

  test("a window formula inside a non-refusal failure teaches nothing (#1199 AC1)", async () => {
    // A hostile or broken upstream body (T2/T3) that names a window inside
    // a 503 is `overloaded` — the kind is the gate, so no
    // `declared_window` event, no store learn, and no trace line either
    // (the trace is for refusals moh could not read).
    const ref = "openrouter/x-ai/grok-4.20";
    const mohHome = home();
    const session = createSession({
      provider: refusingProvider(rawRefusal("Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)", 503), { ref }),
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
      compaction: { enabled: false },
      mohHome,
    });
    await session.send("merge");
    expect(session.declaredWindowFor(ref)).toBeUndefined();
    expect(session.history().some((e) => e.type === "declared_window")).toBe(false);
    expect(session.history().some((e) => e.type === "error" && e.reason === "overloaded")).toBe(true);
    expect(existsSync(contextRefusalsFile(mohHome))).toBe(false);
  });

  test("a refusal declaring a window below the measured context plus reserve is rejected (#1199 AC2)", async () => {
    // The session measured 200,000 input tokens on a served turn; a later
    // `context_length` refusal declaring 131,072 cannot be real — the
    // context already outgrew it. No learn, no event, one trace line.
    const ref = "openrouter/x-ai/grok-4.20";
    const mohHome = home();
    let call = 0;
    const provider: Provider = {
      name: ref,
      async *stream(): AsyncIterable<StreamEvent> {
        if (call++ === 1) throw normalizeProviderError(rawRefusal(OPENROUTER_REFUSAL));
        yield { type: "model_call_start", model: ref };
        yield { type: "text_delta", text: "ok" };
        yield { type: "usage", inputTokens: 200_000, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    };
    const session = createSession({
      provider,
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
      compaction: { enabled: false },
      mohHome,
    });
    await session.send("one"); // served, measures 200,000
    await session.send("two"); // refuses, declaring 131,072 — implausible
    expect(session.declaredWindowFor(ref)).toBeUndefined();
    expect(session.history().some((e) => e.type === "declared_window")).toBe(false);
    const lines = readFileSync(contextRefusalsFile(mohHome), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.model).toBe(ref);
    expect(entry.message).toContain("implausible declared window 131072 (last measured 200000)");
  });

  test("a genuine refusal still teaches after a served turn (#1199 AC3)", async () => {
    // The plausibility bound must not reject the real thing: the window
    // (131,072) leaves the reserve inside the last measured context
    // (100,000), so the correction lands and persists.
    const ref = "openrouter/x-ai/grok-4.20";
    let call = 0;
    const provider: Provider = {
      name: ref,
      async *stream(): AsyncIterable<StreamEvent> {
        if (call++ === 1) throw normalizeProviderError(rawRefusal(OPENROUTER_REFUSAL));
        yield { type: "model_call_start", model: ref };
        yield { type: "text_delta", text: "ok" };
        yield { type: "usage", inputTokens: 100_000, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    };
    const session = createSession({
      provider,
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
      compaction: { enabled: false },
    });
    await session.send("one"); // served, measures 100,000
    await session.send("two"); // genuine refusal, declaring 131,072
    const learned = session.history().find((e) => e.type === "declared_window") as Extract<AgentEvent, { type: "declared_window" }>;
    expect(learned).toMatchObject({ model: ref, window: 131_072 });
    expect(session.declaredWindowFor(ref)).toBe(131_072);
  });

  test("a refusal moh does not recognize changes no number and writes one trace line", async () => {
    const ref = "openrouter/x-ai/grok-4.20";
    const mohHome = home();
    const session = createSession({
      provider: refusingProvider(rawRefusal(UNRECOGNIZED_REFUSAL), { ref }),
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
      compaction: { enabled: false },
      mohHome,
    });
    await session.send("merge");
    expect(session.declaredWindowFor(ref)).toBeUndefined();
    expect(session.history().some((e) => e.type === "declared_window")).toBe(false);
    // #947 is untouched: the refusal still armed the producer (compaction
    // is disabled here, so assert the turn's shape instead) and the turn
    // itself is the same classified error as before.
    expect(session.history().some((e) => e.type === "error" && e.reason === "context_length")).toBe(true);
    const lines = readFileSync(contextRefusalsFile(mohHome), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ endpoint: "openrouter", model: ref, count: 1 });
    expect(entry.message).toContain(UNRECOGNIZED_REFUSAL);
  });

  test("the learning rides the log without entering provider context", async () => {
    const ref = "openrouter/x-ai/grok-4.20";
    const session = createSession({
      provider: refusingProvider(rawRefusal(OPENROUTER_REFUSAL), { ref }),
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
      compaction: { enabled: false },
    });
    await session.send("merge");
    await session.send("continue");
    expect(session.declaredWindowFor(ref)).toBe(131_072);
    // The second turn ran: a real model call followed the chrome event.
    const calls = session.history().filter((e) => e.type === "model_call") as Extract<AgentEvent, { type: "model_call" }>[];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((e) => e.model === ref)).toBe(true);
  });
});

describe("resume re-derives the declared window from the log", () => {
  test("the same effective window, no second event, no second notice", async () => {
    const ref = "openrouter/x-ai/grok-4.20";
    const first = createSession({
      provider: refusingProvider(rawRefusal(OPENROUTER_REFUSAL), { ref }),
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
      compaction: { enabled: false },
    });
    await first.send("merge");
    const events = first.history();

    const resumed = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      endpoints: endpoints({ name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" }),
      compaction: { enabled: false },
      resume: { events },
    });
    // Same window, derived from the log — and nothing appended for it.
    expect(resumed.declaredWindowFor(ref)).toBe(131_072);
    expect(resumed.history().filter((e) => e.type === "declared_window").length).toBe(1);
    await resumed.send("again");
    expect(resumed.history().filter((e) => e.type === "declared_window").length).toBe(1);
    expect(resumed.declaredWindowFor(ref)).toBe(131_072);
  });

  test("the last correction for a reference wins on replay", () => {
    const declared = DeclaredWindows.fromEvents([
      { type: "declared_window", model: "a/m", window: 100, catalog: 0 },
      { type: "declared_window", model: "a/m", window: 200, catalog: 0 },
      { type: "declared_window", model: "a/other", window: 300, catalog: 0 },
    ] as AgentEvent[]);
    expect(declared.declaredWindowFor("a/m")).toBe(200);
    expect(declared.declaredWindowFor("a/other")).toBe(300);
    expect(declared.declaredWindowFor("a/never-declared")).toBeUndefined();
  });
});

describe("the fit guard and the fallback chain read the declared window", () => {
  const ref = "openrouter/x-ai/grok-4.20";

  async function sessionAfterRefusal(inputTokens: number) {
    const session = createSession({
      provider: refusingProvider(rawRefusal(OPENROUTER_REFUSAL), { ref, inputTokens }),
      endpoints: endpoints(
        { name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" },
        { name: "backup", type: "openrouter", defaultModel: "x-ai/grok-4.20" },
      ),
      compaction: { enabled: false },
    });
    await session.send("merge"); // refuses
    await session.send("continue"); // measures `inputTokens`
    return session;
  }

  test("the exported fit check answers with the declared window", async () => {
    const session = await sessionAfterRefusal(234_666);
    // The catalog row would have passed it: 234,666 ≤ 2,000,000 − 8,192.
    expect(session.contextFit(ref)).toEqual({ fits: false, measured: 234_666, window: 131_072 });
  });

  test("the switch guard refuses on the declared window", async () => {
    const session = await sessionAfterRefusal(200_000);
    const result = session.switchModel(ref === session.activeModel ? "openrouter/openai/gpt-4" : ref);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("context_length");
      expect(result.error).toContain("8191");
    }
  });

  test("the fallback chain's eligibility rule reads the same declared window", async () => {
    // The refusal was learned on `openrouter/x-ai/grok-4.20`; a stop is
    // judged on ITS OWN reference (`backup/...`), so it inherits nothing —
    // the declared window applies to the reference the provider refused.
    // Here the refused reference is the stop itself: the chain was built
    // while that endpoint served the session.
    const session = await sessionAfterRefusal(234_666);
    const stop: EndpointProfile = { name: "openrouter", type: "openrouter", defaultModel: "x-ai/grok-4.20" } as EndpointProfile;
    // Without the declared window the catalog's 2M holds it: eligible.
    expect(fallbackIneligibleReason(stop, undefined, { measuredTokens: 234_666 })).toBeNull();
    const reason = fallbackIneligibleReason(stop, undefined, { measuredTokens: 234_666, declaredWindows: session as DeclaredLookup });
    expect(reason).toContain("too small");
    expect(reason).toContain("131072");
    // A different reference keeps the catalog value (no inheritance).
    const other: EndpointProfile = { name: "backup", type: "openrouter", defaultModel: "x-ai/grok-4.20" } as EndpointProfile;
    expect(fallbackIneligibleReason(other, undefined, { measuredTokens: 234_666, declaredWindows: session as DeclaredLookup })).toBeNull();
  });
});

describe("the compaction producer asks the same lookup", () => {
  const ref = "openrouter/x-ai/grok-4.20";
  const summarizer: CompactionSummarizer = async () => "SUMMARY";

  /** One turn measured at `tokens`, so the tail policy has a real number
   * to weigh against the ceiling. */
  function oneTurn(tokens: number): AgentEvent[] {
    return [
      { type: "user_message", text: "u" },
      { type: "assistant_delta", text: "a" },
      { type: "model_call", model: ref, usage: { inputTokens: tokens, outputTokens: 1 } },
      { type: "done", usage: { inputTokens: tokens, outputTokens: 1 } },
    ];
  }

  function runner(declared?: DeclaredWindows) {
    const appended: AgentEvent[] = [];
    const provider = { name: ref, async *stream(): AsyncIterable<StreamEvent> {} } as Provider;
    const r = new CompactionRunner({
      sessionId: "session-test",
      provider: () => provider,
      endpointType: () => "openrouter",
      ...(declared ? { declaredWindows: () => declared } : {}),
      append: (e) => appended.push(e),
      onCompacted: () => {},
      summarizer,
    });
    return { r, appended };
  }

  test("the auto threshold arms on the declared window, not the catalog row", () => {
    const declared = new DeclaredWindows();
    declared.learn(ref, 131_072);
    // 200k input: under 80% of the catalog's 2,000,000, over 80% of 131,072.
    const events = oneTurn(200_000);
    expect(runner().r.shouldAutoCompact(events)).toBe(false);
    expect(runner(declared).r.shouldAutoCompact(events)).toBe(true);
  });

  test("the tail cut ceiling is the declared window (#949 policy, declared input)", async () => {
    const declared = new DeclaredWindows();
    declared.learn(ref, 131_072);
    // The same single-turn log: the declared window's ceiling (122,880)
    // forces an intra-turn cut, the catalog's (1,991,808) leaves nothing
    // foldable — a visible skip carrying the window it used.
    const withDeclared = runner(declared);
    withDeclared.r.maybeCompact({ status: "error", reason: "context_length", message: "maximum context length" }, oneTurn(200_000), false);
    await withDeclared.r.pending;
    expect(withDeclared.appended.some((e) => e.type === "compaction")).toBe(true);

    const catalogOnly = runner();
    catalogOnly.r.maybeCompact({ status: "error", reason: "context_length", message: "maximum context length" }, oneTurn(200_000), false);
    await catalogOnly.r.pending;
    const skipped = catalogOnly.appended.find((e) => e.type === "compaction_skipped") as Extract<AgentEvent, { type: "compaction_skipped" }>;
    expect(skipped.window).toBe(2_000_000);
    expect(catalogOnly.appended.some((e) => e.type === "compaction")).toBe(false);
  });
});

describe("the trace of unrecognized refusals", () => {
  test("deduplicates the same wording and counts instead of duplicating", () => {
    const mohHome = home();
    const base = { home: mohHome, endpoint: "openrouter", model: "openrouter/x" };
    noteUnrecognizedContextRefusal({ ...base, message: "refused gpt-5: you requested about 234666 tokens", now: new Date("2026-09-27T10:00:00Z") });
    // Same wording, a different measurement: one entry, count 2.
    noteUnrecognizedContextRefusal({ ...base, message: "refused gpt-5: you requested about 234690 tokens", now: new Date("2026-09-27T10:05:00Z") });
    // A different measurement space IS a different wording (the version
    // is part of what must be read): its own entry.
    noteUnrecognizedContextRefusal({ ...base, message: "refused gpt-4: you requested about 234690 tokens", now: new Date("2026-09-27T10:06:00Z") });
    noteUnrecognizedContextRefusal({ ...base, message: "a different wording entirely", now: new Date("2026-09-27T10:07:00Z") });
    const lines = readFileSync(contextRefusalsFile(mohHome), "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    const entries = lines.map((line) => JSON.parse(line));
    expect(entries[0]).toMatchObject({ count: 2, endpoint: "openrouter", model: "openrouter/x" });
    expect(entries[0].at).toBe("2026-09-27T10:00:00.000Z");
    expect(entries[0].last).toBe("2026-09-27T10:05:00.000Z");
    expect(entries[0].message).toContain("234666"); // the first excerpt, verbatim
    expect(entries[1]).toMatchObject({ count: 1 });
    expect(entries[2]).toMatchObject({ count: 1 });
  });

  test("is bounded, and evicts the oldest wording first", () => {
    const mohHome = home();
    for (let i = 0; i < CONTEXT_REFUSAL_MAX_ENTRIES + 5; i++) {
      noteUnrecognizedContextRefusal({
        home: mohHome,
        model: "openrouter/x",
        message: `wording ${"w".repeat(i + 1)}`,
        now: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }
    const entries = readFileSync(contextRefusalsFile(mohHome), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.length).toBe(CONTEXT_REFUSAL_MAX_ENTRIES);
    expect(entries.some((e) => e.message === "wording w")).toBe(false);
    expect(entries.some((e) => e.message === `wording ${"w".repeat(CONTEXT_REFUSAL_MAX_ENTRIES + 5)}`)).toBe(true);
  });

  test("keeps the provider's own text only: cleaned, whitespace-collapsed, capped", () => {
    const mohHome = home();
    noteUnrecognizedContextRefusal({
      home: mohHome,
      model: "zai/m",
      message: `line one\n\nline  two\t\u001b[31mred\u001b[0m ${"y".repeat(500)}`,
      now: new Date("2026-09-27T10:00:00Z"),
    });
    const entry = JSON.parse(readFileSync(contextRefusalsFile(mohHome), "utf8").trim());
    expect(entry.message.startsWith("line one line two red y")).toBe(true);
    expect(entry.message.length).toBe(CONTEXT_REFUSAL_EXCERPT_CHARS);
    expect(entry.message.endsWith("…")).toBe(true);
    expect(entry.endpoint).toBeUndefined();
  });

  test("a corrupt file is skipped, never fatal", () => {
    const mohHome = home();
    const file = contextRefusalsFile(mohHome);
    noteUnrecognizedContextRefusal({ home: mohHome, model: "m", message: "first", now: new Date("2026-09-27T10:00:00Z") });
    writeFileSync(file, `{not json\n${readFileSync(file, "utf8")}`);
    noteUnrecognizedContextRefusal({ home: mohHome, model: "m", message: "second", now: new Date("2026-09-27T10:01:00Z") });
    const entries = readFileSync(file, "utf8").trim().split("\n");
    expect(entries.length).toBe(2);
  });

  test("an unwritable home can never break a turn", () => {
    expect(() =>
      noteUnrecognizedContextRefusal({ home: "/proc/definitely/not/writable", model: "m", message: "x" }),
    ).not.toThrow();
  });
});
