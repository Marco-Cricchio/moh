import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, SessionStore } from "../src/index";
import { ProviderRegistry } from "../src/provider-registry";
import { createRoute, Endpoint } from "../src/route";
import { replayMessages } from "../src/session-store";
import { ProviderError, type AgentEvent, type Message, type Provider, type StreamEvent } from "../src/types";

/**
 * #243: cross-layer reasoning semantics at session lifecycle boundaries.
 * Tests stay at the public AgentSession/provider and persisted-log seams.
 * Small providers are intentional where MockProvider cannot capture inbound
 * context, expose distinct switch/fallback model names, or omit `finish`.
 */

describe("reasoning lifecycle integration (#243)", () => {
  test("completed reasoning and opaque metadata survive JSONL persistence, fork, and resume", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-reasoning-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "moh-reasoning-project-"));
    const store = SessionStore.create(cwd, home);
    const provider: Provider = {
      name: "reasoner",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "model_call_start", model: "reasoner" };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "persisted thought" };
        yield { type: "reasoning_end", continuation: { signature: "opaque-1" } };
        yield { type: "text_delta", text: "persisted answer" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const original = createSession({ provider, sink: (event) => store.append(event) });
    await original.send("first");

    const persisted = store.load();
    expect(persisted).toContainEqual({
      type: "reasoning",
      text: "persisted thought",
      continuation: { signature: "opaque-1" },
    });
    const originalBytes = readFileSync(store.file, "utf8");
    const fork = store.fork();
    expect(readFileSync(fork.file, "utf8")).toBe(originalBytes);

    let resumedContext: Message[] = [];
    const capture: Provider = {
      name: "reasoner",
      async *stream(messages): AsyncIterable<StreamEvent> {
        resumedContext = structuredClone(messages);
        yield { type: "model_call_start", model: "reasoner" };
        yield { type: "text_delta", text: "continued" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const resumed = createSession({
      provider: capture,
      resume: { events: fork.load() },
      sink: (event) => fork.append(event),
    });
    await resumed.send("continue");

    expect(resumedContext.flatMap((message) => message.parts)).toContainEqual({
      kind: "reasoning",
      text: "persisted thought",
      continuation: { signature: "opaque-1" },
    });
    expect(readFileSync(fork.file, "utf8").startsWith(originalBytes)).toBe(true);
    expect(readFileSync(store.file, "utf8")).toBe(originalBytes);
  });

  test("a model switch keeps completed reasoning context and audits the next model's effective level", async () => {
    const firstProvider: Provider = {
      name: "alpha/model-a",
      async *stream(_messages, _signal, _tools, options): AsyncIterable<StreamEvent> {
        yield { type: "model_call_start", model: "alpha/model-a", thinkingLevel: options?.thinking?.level };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "alpha thought" };
        yield { type: "reasoning_end", continuation: { signature: "alpha-signature" } };
        yield { type: "text_delta", text: "alpha answer" };
        yield { type: "finish", reason: "stop" };
      },
    };
    let switchedContext: Message[] = [];
    const secondProvider: Provider = {
      name: "beta/model-b",
      async *stream(messages, _signal, _tools, options): AsyncIterable<StreamEvent> {
        switchedContext = structuredClone(messages);
        yield { type: "model_call_start", model: "beta/model-b", thinkingLevel: options?.thinking?.level };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "beta thought" };
        yield { type: "reasoning_end", continuation: { signature: "beta-signature" } };
        yield { type: "text_delta", text: "beta answer" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const registry = new ProviderRegistry()
      .registerProvider("alpha", () => firstProvider)
      .registerProvider("beta", () => secondProvider);
    const session = createSession({ provider: "alpha", registry, thinking: { level: "high" } });

    await session.send("first");
    expect(session.switchModel("beta")).toEqual({ ok: true, model: "beta/model-b" });
    await session.send("second");

    expect(switchedContext.flatMap((message) => message.parts)).toContainEqual({
      kind: "reasoning",
      text: "alpha thought",
      continuation: { signature: "alpha-signature" },
    });
    expect(
      session.history().filter((event) => event.type === "model_call").map((event) => ({ model: event.model, thinkingLevel: event.thinkingLevel })),
    ).toEqual([
      { model: "alpha/model-a", thinkingLevel: "high" },
      { model: "beta/model-b", thinkingLevel: "high" },
    ]);
  });

  test("fallback persists each call's reasoning and audits the effective level per serving model", async () => {
    const primary = new Endpoint({ name: "primary", kind: "mock" });
    const secondary = new Endpoint({ name: "secondary", kind: "mock" });
    const route = createRoute({
      target: { endpoint: primary, modelId: "model-a" },
      fallbacks: [{ endpoint: secondary, modelId: "model-b" }],
      retries: 0,
      thinkingForTarget: (target) => ({ level: target.endpoint.name === "primary" ? "high" : "low" }),
      createStream: (target) => {
        if (target.endpoint.name === "primary") {
          return async function* (_messages, _signal, _tools, options): AsyncIterable<StreamEvent> {
            yield { type: "model_call_start", model: "primary/model-a", thinkingLevel: options?.thinking?.level };
            yield { type: "reasoning_start" };
            yield { type: "reasoning_delta", text: "primary thought" };
            yield { type: "reasoning_end", continuation: { signature: "primary-signature" } };
            throw new ProviderError("quota_exhausted", "quota exhausted");
          };
        }
        return async function* (_messages, _signal, _tools, options): AsyncIterable<StreamEvent> {
          yield { type: "model_call_start", model: "secondary/model-b", thinkingLevel: options?.thinking?.level };
          yield { type: "reasoning_start" };
          yield { type: "reasoning_delta", text: "secondary thought" };
          yield { type: "reasoning_end", continuation: { signature: "secondary-signature" } };
          yield { type: "text_delta", text: "fallback answer" };
          yield { type: "finish", reason: "stop" };
        };
      },
    });
    const session = createSession({ provider: route });
    await session.send("use fallback");

    expect(session.history().filter((event) => event.type === "reasoning")).toEqual([
      { type: "reasoning", text: "primary thought" },
      { type: "reasoning", text: "secondary thought", continuation: { signature: "secondary-signature" } },
    ]);
    expect(session.history()).toContainEqual({ type: "model_call", model: "primary/model-a", usage: { inputTokens: 0, outputTokens: 0 }, thinkingLevel: "high", failed: true });
    expect(session.history()).toContainEqual({
      type: "fallback",
      from: "primary/model-a",
      to: "secondary/model-b",
      reason: "quota_exhausted",
    });
    expect(
      session.history().filter((event) => event.type === "model_call").map((event) => ({ model: event.model, thinkingLevel: event.thinkingLevel })),
    ).toEqual([
      { model: "primary/model-a", thinkingLevel: "high" },
      { model: "secondary/model-b", thinkingLevel: "low" },
    ]);
    const replayedParts = replayMessages(session.history()).flatMap((message) => message.parts);
    expect(replayedParts).not.toContainEqual({ kind: "reasoning", text: "primary thought" });
    expect(replayedParts).toContainEqual({
      kind: "reasoning",
      text: "secondary thought",
      continuation: { signature: "secondary-signature" },
    });
  });

  test("compaction replaces old reasoning in provider context while retaining the recent reasoning tail", async () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "user_message", text: "old question" },
      { type: "assistant_delta", text: "old answer" },
      { type: "reasoning", text: "old thought", continuation: { signature: "old-signature" } },
      { type: "model_call", model: "reasoner", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "done" },
      { type: "compaction", summary: "The earlier exchange established the old result.", upTo: 6 },
      { type: "user_message", text: "recent question" },
      { type: "assistant_delta", text: "recent answer" },
      { type: "reasoning", text: "recent thought", continuation: { signature: "recent-signature" } },
      { type: "model_call", model: "reasoner", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "done" },
    ];
    const home = mkdtempSync(join(tmpdir(), "moh-compaction-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "moh-compaction-project-"));
    const store = SessionStore.create(cwd, home);
    for (const event of events) store.append(event);
    const integralBytes = readFileSync(store.file, "utf8");

    let compactedContext: Message[] = [];
    const capture: Provider = {
      name: "reasoner",
      async *stream(messages): AsyncIterable<StreamEvent> {
        compactedContext = structuredClone(messages);
        yield { type: "model_call_start", model: "reasoner" };
        yield { type: "text_delta", text: "continued" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const session = createSession({
      provider: capture,
      resume: { events: store.load() },
      sink: (event) => store.append(event),
    });
    await session.send("continue");

    const contextParts = compactedContext.flatMap((message) => message.parts);
    expect(contextParts).toContainEqual({
      kind: "text",
      text: "[Compaction summary]\nThe earlier exchange established the old result.",
    });
    expect(contextParts).toContainEqual({
      kind: "reasoning",
      text: "recent thought",
      continuation: { signature: "recent-signature" },
    });
    expect(contextParts).not.toContainEqual({
      kind: "reasoning",
      text: "old thought",
      continuation: { signature: "old-signature" },
    });
    expect(contextParts).not.toContainEqual({ kind: "text", text: "old question" });
    const afterResume = readFileSync(store.file, "utf8");
    expect(afterResume.startsWith(integralBytes)).toBe(true);
    expect(afterResume).toContain("old-signature");
  });

  test("a stream that ends before finish is cancelled without checkpointing reasoning", async () => {
    const provider: Provider = {
      name: "reasoner",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "model_call_start", model: "reasoner" };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "unfinalized thought" };
        yield { type: "reasoning_end", continuation: { signature: "unfinalized-signature" } };
      },
    };
    const session = createSession({ provider });

    expect(await session.send("incomplete")).toEqual({ status: "cancelled" });
    // Log retention without checkpointing: the reasoning text stays in the
    // log (no continuation), marked by a failed model_call; replay excludes
    // it from provider context.
    expect(session.history().filter((event) => event.type === "reasoning")).toEqual([
      { type: "reasoning", text: "unfinalized thought" },
    ]);
    expect(session.history()).toContainEqual({ type: "model_call", model: "reasoner", usage: { inputTokens: 0, outputTokens: 0 }, failed: true });
    expect(replayMessages(session.history()).flatMap((message) => message.parts)).not.toContainEqual({ kind: "reasoning", text: "unfinalized thought" });
    expect(session.history().at(-1)).toEqual({ type: "cancelled" });
  });

  test("a failed same-target retry is log-only: its partial content never enters replay context", async () => {
    let attempt = 0;
    const provider: Provider = {
      name: "reasoner",
      async *stream(_messages, _signal, _tools, options): AsyncIterable<StreamEvent> {
        attempt += 1;
        yield { type: "model_call_start", model: "reasoner", thinkingLevel: options?.thinking?.level };
        if (attempt === 1) {
          yield { type: "reasoning_start" };
          yield { type: "reasoning_delta", text: "doomed attempt thought" };
          yield { type: "reasoning_end", continuation: { signature: "doomed" } };
          yield { type: "text_delta", text: "doomed partial" };
          throw new ProviderError("rate_limited", "slow down");
        }
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "retry thought" };
        yield { type: "reasoning_end", continuation: { signature: "retry" } };
        yield { type: "text_delta", text: "recovered" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const route = createRoute({
      target: { endpoint: new Endpoint({ name: "ep", kind: "mock" }), modelId: "m" },
      retries: 1,
      retryBackoffMs: 0,
      createStream: () => (messages, signal, tools, opts) => provider.stream(messages, signal, tools, opts),
    });
    const session = createSession({ provider: route, thinking: { level: "low" } });
    expect(await session.send("retry me")).toEqual({ status: "done" });

    const log = session.history();
    expect(log).toContainEqual({ type: "model_call", model: "reasoner", usage: { inputTokens: 0, outputTokens: 0 }, thinkingLevel: "low", failed: true });
    const replayedParts = replayMessages(log).flatMap((message) => message.parts);
    expect(replayedParts).not.toContainEqual({ kind: "reasoning", text: "doomed attempt thought" });
    expect(replayedParts).not.toContainEqual({ kind: "text", text: "doomed partial" });
    expect(replayedParts).toContainEqual({ kind: "reasoning", text: "retry thought", continuation: { signature: "retry" } });
  });

  test("resume starts from the last completed call and excludes an interrupted call's reasoning metadata", async () => {
    let call = 0;
    const original: Provider = {
      name: "reasoner",
      async *stream(_messages, signal): AsyncIterable<StreamEvent> {
        call += 1;
        yield { type: "model_call_start", model: "reasoner" };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: call === 1 ? "completed thought" : "interrupted thought" };
        yield {
          type: "reasoning_end",
          continuation: { signature: call === 1 ? "completed-signature" : "interrupted-signature" },
        };
        if (call === 1) {
          yield { type: "text_delta", text: "completed answer" };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "text_delta", text: "interrupted answer" };
        while (!signal.aborted) await Bun.sleep(1);
      },
    };

    const first = createSession({ provider: original });
    await first.send("complete this call");
    const interrupted = first.send("interrupt this call");
    await Bun.sleep(10);
    first.abort();
    expect(await interrupted).toEqual({ status: "cancelled" });

    const persisted = first.history();
    const reasoning = persisted.filter((event) => event.type === "reasoning");
    // The interrupted call's reasoning stays in the append-only log for
    // audit/display, but without its continuation and marked failed — it
    // never becomes resumable provider context.
    expect(reasoning).toEqual([
      { type: "reasoning", text: "completed thought", continuation: { signature: "completed-signature" } },
      { type: "reasoning", text: "interrupted thought" },
    ]);
    expect(persisted).toContainEqual({ type: "model_call", model: "reasoner", usage: { inputTokens: 0, outputTokens: 0 }, failed: true });

    let resumedContext: Message[] = [];
    const resumedProvider: Provider = {
      name: "reasoner",
      async *stream(messages): AsyncIterable<StreamEvent> {
        resumedContext = structuredClone(messages);
        yield { type: "model_call_start", model: "reasoner" };
        yield { type: "text_delta", text: "resumed" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const resumed = createSession({ provider: resumedProvider, resume: { events: persisted } });
    await resumed.send("continue");

    const resumedParts = resumedContext.flatMap((message) => message.parts);
    const replayedReasoning = resumedParts.filter((part) => part.kind === "reasoning");
    expect(replayedReasoning).toEqual([
      {
        kind: "reasoning",
        text: "completed thought",
        continuation: { signature: "completed-signature" },
      },
    ]);
    expect(resumedParts).not.toContainEqual({ kind: "text", text: "interrupted answer" });
  });
  test("a reasoning-only OpenRouter stream is not treated as an empty/no-output stream by the session", async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const line = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const sse = [
      line({ id: "c", created: 1, model: "m", choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.text", text: "silent thinking" }] } }] }),
      line({ id: "c", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
      "data: [DONE]\n\n",
    ].join("");
    globalThis.fetch = (async (_input: any, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(sse)); c.close(); } }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch;
    try {
      const provider = createRoute({
        target: {
          endpoint: new Endpoint({ name: "or", kind: "openrouter", apiKey: "k" }),
          modelId: "openai/gpt-5.6-luna",
          compat: { thinkingFormat: "openrouter" },
        },
      });
      const session = createSession({ provider });
      const result = await session.send("think only");
      expect(result).toEqual({ status: "done" });
      const persisted = session.history();
      expect(persisted).toContainEqual({
        type: "reasoning",
        text: "silent thinking",
        continuation: { openrouter: { reasoningDetails: [{ type: "reasoning.text", text: "silent thinking" }] } },
      });
      expect(persisted.filter((e) => e.type === "error")).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("openrouter reasoning end-to-end (#251)", () => {
  test("a completed OpenRouter reasoning block is persisted before its model_call and stays renderable", async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const line = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const sse = [
      line({ id: "c", created: 1, model: "m", choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.text", text: "or thought" }] } }] }),
      line({ id: "c", created: 1, model: "m", choices: [{ index: 0, delta: { content: "or answer" } }] }),
      line({ id: "c", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
      "data: [DONE]\n\n",
    ].join("");
    let requestBody: any;
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(sse)); c.close(); } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const provider = createRoute({
        target: {
          endpoint: new Endpoint({ name: "or", kind: "openrouter", apiKey: "k" }),
          modelId: "openai/gpt-5.6-luna",
          compat: { thinkingFormat: "openrouter" },
        },
      });
      const session = createSession({ provider, thinking: { level: "max" } });
      await session.send("think hard");
      expect(requestBody.reasoning).toEqual({ effort: "max", exclude: false });

      const persisted = session.history();
      const reasoningIdx = persisted.findIndex((e) => e.type === "reasoning");
      const modelCallIdx = persisted.findIndex((e) => e.type === "model_call");
      expect(reasoningIdx).toBeGreaterThan(-1);
      expect(modelCallIdx).toBeGreaterThan(reasoningIdx);
      expect(persisted[reasoningIdx]).toEqual({
        type: "reasoning",
        text: "or thought",
        continuation: { openrouter: { reasoningDetails: [{ type: "reasoning.text", text: "or thought" }] } },
      });
      expect(persisted).toContainEqual(
        expect.objectContaining({ type: "model_call", model: "or/openai/gpt-5.6-luna", usage: { inputTokens: 2, outputTokens: 3 }, thinkingLevel: "max" }),
      );
      // replay seam: the persisted reasoning part rides provider context (TUI projection source).
      let resumedContext: import("../src/types").Message[] = [];
      const capture: Provider = {
        name: "or",
        async *stream(messages): AsyncIterable<StreamEvent> {
          resumedContext = structuredClone(messages);
          yield { type: "model_call_start", model: "or/openai/gpt-5.6-luna" };
          yield { type: "text_delta", text: "next" };
          yield { type: "finish", reason: "stop" };
        },
      };
      const resumed = createSession({ provider: capture, resume: { events: persisted } });
      await resumed.send("continue");
      const resumedParts = resumedContext.flatMap((m) => m.parts);
      expect(resumedParts).toContainEqual({
        kind: "reasoning",
        text: "or thought",
        continuation: { openrouter: { reasoningDetails: [{ type: "reasoning.text", text: "or thought" }] } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
