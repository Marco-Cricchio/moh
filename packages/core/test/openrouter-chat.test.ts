import { describe, expect, it } from "bun:test";
import { aiSdkStreamFor } from "../src/providers/ai-sdk";
import { Endpoint, type RouteTarget } from "../src/route";
import { catalogTargetOverrides } from "../src/provider-registry";
import type { Message, StreamEvent } from "../src/types";

/** #251: OpenRouter reasoning (#251) — request translation at the
 * compat/wire seam (`compat.thinkingFormat: "openrouter"`) and streamed
 * `delta.reasoning_details` → neutral reasoning lifecycle events.
 *
 * Tests stub global fetch: deterministic synthetic OpenRouter-compatible
 * Chat Completions SSE chunks, with exact request-body assertions. */

type FetchCall = { url: string; body: any };

function openRouterTarget(): RouteTarget {
  return {
    endpoint: new Endpoint({ name: "or", kind: "openrouter", apiKey: "k" }),
    modelId: "openai/gpt-5.6-luna",
    compat: { thinkingFormat: "openrouter" },
  };
}

/** SSE response from raw chunk strings, split at arbitrary byte
 * boundaries to exercise the line buffering. */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        const bytes = encoder.encode(event);
        // split every event into two odd-sized pieces
        const mid = Math.max(1, Math.floor(bytes.length / 3));
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "c1", created: 1, model: "m", choices: [{ index: 0, delta, ...extra }], ...("usage" in extra ? { usage: extra.usage } : {}) })}\n\n`;

function harness(events: string[]) {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.url, body: JSON.parse(String(init?.body)) });
    return sseResponse(events);
  }) as typeof fetch;
  const restore = () => {
    globalThis.fetch = originalFetch;
  };
  const target = openRouterTarget();
  const stream = aiSdkStreamFor(target, "k", undefined);
  return {
    calls,
    restore,
    run: async (messages: Message[], options?: import("../src/types").StreamOptions): Promise<StreamEvent[]> => {
      const events: StreamEvent[] = [];
      try {
        for await (const e of stream(messages, new AbortController().signal, undefined, options)) events.push(e);
      } finally {
        restore();
      }
      return events;
    },
  };
}

const userMsg: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];

const doneEvent = "data: [DONE]\n\n";

describe("openrouter chat reasoning (#251)", () => {
  it("maps the neutral level to OpenRouter's documented reasoning.effort request shape", async () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      const h = harness([chunk({ role: "assistant", content: "ok" }, { finish_reason: "stop", usage: null }), doneEvent]);
      const events = await h.run(userMsg, { thinking: { level } });
      expect(events[0]).toEqual({ type: "model_call_start", model: "or/openai/gpt-5.6-luna", thinkingLevel: level });
      expect(h.calls[0]!.body.reasoning).toEqual({ effort: level, exclude: false });
      expect(h.calls[0]!.body.reasoning_effort).toBeUndefined();
    }
  });

  it("sends no reasoning block for off, and none when no thinking option is set", async () => {
    const h = harness([chunk({ role: "assistant", content: "ok" }, { finish_reason: "stop", usage: null }), doneEvent]);
    await h.run(userMsg, { thinking: { level: "off" } });
    expect(h.calls[0]!.body.reasoning).toBeUndefined();
    expect(h.calls[0]!.body.reasoning_effort).toBeUndefined();

    const h2 = harness([chunk({ role: "assistant", content: "ok" }, { finish_reason: "stop", usage: null }), doneEvent]);
    await h2.run(userMsg);
    expect(h2.calls[0]!.body.reasoning).toBeUndefined();
    expect(h2.calls[0]!.body.reasoning_effort).toBeUndefined();
  });

  it("translates multi-chunk reasoning_details into ordered neutral reasoning events before text", async () => {
    const h = harness([
      chunk({ role: "assistant" }, {}),
      chunk({ reasoning_details: [{ type: "reasoning.text", text: "step one. " }] }),
      chunk({ reasoning_details: [{ type: "reasoning.text", text: "step two. " }, { type: "reasoning.encrypted", data: "opaque-1" }] }),
      chunk({ reasoning_details: [{ type: "reasoning.text", text: "step three." }] }),
      chunk({ content: "the answer" }),
      chunk({}, { finish_reason: "stop", usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }),
      doneEvent,
    ]);
    const events = await h.run(userMsg, { thinking: { level: "high" } });
    expect(events).toEqual([
      { type: "model_call_start", model: "or/openai/gpt-5.6-luna", thinkingLevel: "high" },
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "step one. " },
      { type: "reasoning_delta", text: "step two. " },
      { type: "reasoning_delta", text: "step three." },
      {
        type: "reasoning_end",
        continuation: {
          openrouter: {
            reasoningDetails: [
              { type: "reasoning.text", text: "step one. " },
              { type: "reasoning.text", text: "step two. " },
              { type: "reasoning.encrypted", data: "opaque-1" },
              { type: "reasoning.text", text: "step three." },
            ],
          },
        },
      },
      { type: "text_delta", text: "the answer" },
      { type: "usage", inputTokens: 3, outputTokens: 5 },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("supports the legacy delta.reasoning string field", async () => {
    const h = harness([
      chunk({ reasoning: "legacy thought" }),
      chunk({ content: "answer" }),
      chunk({}, { finish_reason: "stop", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      doneEvent,
    ]);
    const events = await h.run(userMsg);
    expect(events).toContainEqual({ type: "reasoning_delta", text: "legacy thought" });
    expect(events.filter((e) => e.type === "reasoning_end")[0]).toEqual({
      type: "reasoning_end",
      continuation: { openrouter: { reasoningDetails: [{ type: "reasoning.text", text: "legacy thought" }] } },
    });
  });

  it("a reasoning-only stream is not treated as an empty stream: reasoning flushes at the end", async () => {
    const h = harness([
      chunk({ reasoning_details: [{ type: "reasoning.text", text: "only thinking" }] }),
      chunk({ reasoning_details: [{ type: "reasoning.text", text: ", more" }] }),
      chunk({}, { finish_reason: "stop", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      doneEvent,
    ]);
    const events = await h.run(userMsg);
    expect(events).toEqual([
      { type: "model_call_start", model: "or/openai/gpt-5.6-luna" },
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "only thinking" },
      { type: "reasoning_delta", text: ", more" },
      { type: "reasoning_end", continuation: { openrouter: { reasoningDetails: [
        { type: "reasoning.text", text: "only thinking" },
        { type: "reasoning.text", text: ", more" },
      ] } } },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("streams without reasoning are unchanged", async () => {
    const h = harness([
      chunk({ role: "assistant", content: "plain " }),
      chunk({ content: "answer" }),
      chunk({}, { finish_reason: "stop", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
      doneEvent,
    ]);
    const events = await h.run(userMsg);
    expect(events).toEqual([
      { type: "model_call_start", model: "or/openai/gpt-5.6-luna" },
      { type: "text_delta", text: "plain " },
      { type: "text_delta", text: "answer" },
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("catalog compat metadata reaches route targets (catalogTargetOverrides)", () => {
    const entry = catalogTargetOverrides("openrouter", "openai/gpt-5.6-luna");
    expect((entry as { compat?: Record<string, unknown> }).compat).toEqual(
      expect.objectContaining({ thinkingFormat: "openrouter" }),
    );
  });
});
