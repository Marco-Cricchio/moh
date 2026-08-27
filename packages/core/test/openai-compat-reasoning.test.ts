import { describe, expect, it } from "bun:test";
import { aiSdkStreamFor } from "../src/providers/ai-sdk";
import { Endpoint, type RouteTarget } from "../src/route";
import type { Message, StreamEvent } from "../src/types";

/** #262: generic openai-compat backends that declare a thinking
 * capability (`capabilities.thinking`) get the reasoning-aware wire
 * wrapper: streamed reasoning in the DeepSeek/Z.AI dialect
 * (`delta.reasoning_content`) and the OpenAI/OpenRouter dialects
 * (`reasoning_effort` request passthrough, `delta.reasoning`,
 * `delta.reasoning_details`) reach moh's neutral reasoning lifecycle.
 * The declared `openai-effort` format keeps the standard
 * `reasoning_effort` request field — no OpenRouter rewrite. */

type FetchCall = { url: string; body: any };

function compatTarget(format: "openai-effort" | "openrouter-effort"): RouteTarget {
  return {
    endpoint: new Endpoint({ name: "zai", kind: "openai", apiKey: "k" }),
    modelId: "glm-5.3",
    thinkingFormat: format,
  };
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        const bytes = encoder.encode(event);
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

function harness(events: string[], format: "openai-effort" | "openrouter-effort" = "openai-effort") {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.url, body: JSON.parse(String(init?.body)) });
    return sseResponse(events);
  }) as typeof fetch;
  const restore = () => {
    globalThis.fetch = originalFetch;
  };
  const target = compatTarget(format);
  const stream = aiSdkStreamFor(target, "k", undefined);
  return {
    calls,
    restore,
    run: async (options?: import("../src/types").StreamOptions): Promise<StreamEvent[]> => {
      const events: StreamEvent[] = [];
      try {
        for await (const e of stream(
          [{ role: "user", parts: [{ kind: "text", text: "hi" }] }] as Message[],
          new AbortController().signal,
          undefined,
          options,
        )) {
          events.push(e);
        }
      } finally {
        restore();
      }
      return events;
    },
  };
}

const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };

describe("openai-compat declared thinking capability (#262)", () => {
  it("translates streamed reasoning_content (DeepSeek/Z.AI dialect) into the neutral reasoning lifecycle", async () => {
    const h = harness([
      chunk({ role: "assistant" }),
      chunk({ reasoning_content: "step one. " }),
      chunk({ reasoning_content: "step two." }),
      chunk({ content: "the answer" }),
      chunk({}, { finish_reason: "stop", usage }),
      "data: [DONE]\n\n",
    ]);
    const events = await h.run();
    expect(events).toContainEqual({ type: "reasoning_start" });
    expect(events).toContainEqual({ type: "reasoning_delta", text: "step one. " });
    expect(events).toContainEqual({ type: "reasoning_delta", text: "step two." });
    // reasoning_end carries opaque continuation metadata — match by type
    expect(events.some((e) => e.type === "reasoning_end")).toBe(true);
    expect(events).toContainEqual({ type: "text_delta", text: "the answer" });
    // reasoning precedes text in the lifecycle
    const firstReasoning = events.findIndex((e) => e.type === "reasoning_start");
    const firstText = events.findIndex((e) => e.type === "text_delta");
    expect(firstReasoning).toBeLessThan(firstText);
  });

  it("keeps the standard reasoning_effort request field for the openai-effort format", async () => {
    const h = harness([chunk({ role: "assistant" }), chunk({ content: "ok" }), "data: [DONE]\n\n"]);
    await h.run({ thinking: { level: "high" } });
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls[0]!.body.reasoning_effort).toBe("high");
    expect(h.calls[0]!.body.reasoning).toBeUndefined(); // no openrouter rewrite
  });

  it("rewrites to OpenRouter's reasoning shape for the openrouter-effort format", async () => {
    const h = harness([chunk({ role: "assistant" }), chunk({ content: "ok" }), "data: [DONE]\n\n"], "openrouter-effort");
    await h.run({ thinking: { level: "max" } });
    expect(h.calls[0]!.body.reasoning).toEqual({ effort: "max", exclude: false });
    expect(h.calls[0]!.body.reasoning_effort).toBeUndefined();
  });

  it("reasoning-only streams are not empty: deltas flow without any content chunk", async () => {
    const h = harness([
      chunk({ role: "assistant" }),
      chunk({ reasoning_content: "only thinking" }),
      chunk({}, { finish_reason: "stop", usage }),
      "data: [DONE]\n\n",
    ]);
    const events = await h.run();
    expect(events).toContainEqual({ type: "reasoning_delta", text: "only thinking" });
    expect(events.some((e) => e.type === "reasoning_end")).toBe(true);
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("legacy delta.reasoning and openrouter reasoning_details still extract under the declared format", async () => {
    const h = harness([
      chunk({ reasoning: "legacy line" }),
      chunk({ reasoning_details: [{ type: "reasoning.text", text: "detail line" }] }),
      chunk({ content: "done" }),
      chunk({}, { finish_reason: "stop", usage }),
      "data: [DONE]\n\n",
    ]);
    const events = await h.run();
    expect(events).toContainEqual({ type: "reasoning_delta", text: "legacy line" });
    expect(events).toContainEqual({ type: "reasoning_delta", text: "detail line" });
    expect(events).toContainEqual({ type: "text_delta", text: "done" });
  });

  it("backends without reasoning are unchanged: plain content streams normally", async () => {
    const h = harness([
      chunk({ role: "assistant" }),
      chunk({ content: "plain" }),
      chunk({}, { finish_reason: "stop", usage }),
      "data: [DONE]\n\n",
    ]);
    const events = await h.run();
    expect(events.some((e) => e.type === "reasoning_start")).toBe(false);
    expect(events).toContainEqual({ type: "text_delta", text: "plain" });
  });
});
