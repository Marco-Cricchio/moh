import { describe, expect, it } from "bun:test";
import { simulateReadableStream } from "ai/test";
import { aiSdkStreamFor } from "../src/providers/ai-sdk";
import { Endpoint, type RouteTarget } from "../src/route";
import type { LanguageModel } from "ai";
import type { Message, StreamEvent, StreamOptions, ToolSpec } from "../src/types";

/** #240: adapter translation of provider reasoning (both directions) and
 * per-wire thinking-level mapping (no silent remapping of holes). */

type StreamPart = Record<string, unknown> & { type: string };

function mockModel(parts: StreamPart[], calls: any[]): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "mock",
    doStream: async (args: any) => {
      calls.push(args);
      return { stream: simulateReadableStream({ chunks: parts }) as any };
    },
  } as unknown as LanguageModel;
}

function harness(parts: StreamPart[], kind: ConstructorParameters<typeof Endpoint>[0]["kind"] = "openai", wire?: import("../src/wire").WireApi, thinkingFormat?: import("../src/types").ThinkingFormat) {
  const calls: any[] = [];
  const target: RouteTarget = {
    endpoint: new Endpoint({ name: "t", kind, apiKey: "k" }),
    modelId: "m",
    ...(wire ? { wire } : {}),
    ...(thinkingFormat ? { thinkingFormat } : {}),
  };
  const stream = aiSdkStreamFor(target, "k", undefined, mockModel(parts, calls));
  return {
    calls,
    run: async (messages: Message[], options?: import("../src/types").StreamOptions, tools?: readonly ToolSpec[]): Promise<StreamEvent[]> => {
      const events: StreamEvent[] = [];
      for await (const e of stream(messages, new AbortController().signal, tools, options)) events.push(e);
      return events;
    },
  };
}

const tools: readonly ToolSpec[] = [{ name: "bash", description: "run", parameters: { type: "object", properties: {} } }];

const finish = () => ({
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 }, totalTokens: 3 },
});

describe("ai-sdk reasoning translation (#240)", () => {
  it("translates reasoning stream parts to neutral lifecycle events, with continuation metadata", async () => {
    const h = harness([
      { type: "reasoning-start", id: "r0" },
      { type: "reasoning-delta", id: "r0", delta: "step one. " },
      { type: "reasoning-delta", id: "r0", delta: "step two." },
      { type: "reasoning-end", id: "r0", providerMetadata: { anthropic: { signature: "sig-9" } } },
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "answer" },
      { type: "text-end", id: "t0" },
      finish(),
    ]);
    const events = await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }]);
    expect(events).toEqual([
      { type: "model_call_start", model: "t/m", endpoint: { kind: "openai" }, wire: "openai-chat" },
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "step one. " },
      { type: "reasoning_delta", text: "step two." },
      { type: "reasoning_end", continuation: { anthropic: { signature: "sig-9" } } },
      { type: "text_delta", text: "answer" },
      { type: "usage", inputTokens: 1, outputTokens: 2, provenance: "provider" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("sends replayed reasoning back to the provider with its continuation artifacts", async () => {
    const h = harness([finish()]);
    await h.run([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      { role: "assistant", parts: [{ kind: "reasoning", text: "thinking hard", continuation: { anthropic: { signature: "s" } } }, { kind: "text", text: "yo" }] },
    ]);
    const assistant = h.calls[0]!.prompt.find((m: any) => m.role === "assistant");
    expect(assistant.content).toContainEqual({
      type: "reasoning",
      text: "thinking hard",
      providerOptions: { anthropic: { signature: "s" } },
    });
  });
});

describe("ai-sdk thinking-level mapping (#240)", () => {
  it("anthropic: native levels map to effort; off disables; the announcement audits the effective level", async () => {
    const h = harness([finish()], "anthropic");
    const events = await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "high" } });
    expect(events[0]).toEqual({ type: "model_call_start", model: "t/m", thinkingLevel: "high", endpoint: { kind: "anthropic" }, wire: "anthropic-messages" });
    expect(h.calls[0]!.providerOptions).toEqual({ anthropic: { effort: "high" } });

    const h2 = harness([finish()], "anthropic");
    await h2.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "off" } });
    expect(h2.calls[0]!.providerOptions).toEqual({ anthropic: { thinking: { type: "disabled" } } });
  });

  it("openai: levels map to reasoningEffort, off to none", async () => {
    const h = harness([finish()], "openai");
    await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "xhigh" } });
    expect(h.calls[0]!.providerOptions).toEqual({ openai: { reasoningEffort: "xhigh" } });
  });

  it("google: low/medium/high are native; xhigh/max are not sent and not audited (no silent remap)", async () => {
    const h = harness([finish()], "google");
    await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "medium" } });
    expect(h.calls[0]!.providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: "medium" } } });

    const h2 = harness([finish()], "google");
    const events = await h2.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "max" } });
    expect(h2.calls[0]!.providerOptions).toBeUndefined();
    expect(events[0]).toEqual({ type: "model_call_start", model: "t/m", endpoint: { kind: "google" }, wire: "google" });
  });

  it("no thinking option sends no providerOptions at all", async () => {
    const h = harness([finish()], "openai");
    await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }]);
    expect(h.calls[0]!.providerOptions).toBeUndefined();
  });
});

// #1723: OpenAI's own chat/completions wire refuses function tools together
// with a non-none `reasoning_effort` — and refuses the pair for a
// reasoning-by-default model even when no effort is sent. The effort is
// pinned to none whenever tools travel, on that wire and that kind only.
describe("OpenAI chat wire pins the effort when tools travel (#1723)", () => {
  it("no resolved level: still sends none, and announces no level", async () => {
    const h = harness([finish()], "openai");
    const events = await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], undefined, tools);
    expect(h.calls[0]!.providerOptions).toEqual({ openai: { reasoningEffort: "none" } });
    expect(events[0]).toEqual({ type: "model_call_start", model: "t/m", endpoint: { kind: "openai" }, wire: "openai-chat" });
  });

  it("a resolved level is downgraded to off, and the audit says what was sent", async () => {
    const h = harness([finish()], "openai");
    const events = await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "medium" } }, tools);
    expect(h.calls[0]!.providerOptions).toEqual({ openai: { reasoningEffort: "none" } });
    expect(events[0]).toMatchObject({ thinkingLevel: "off" });
  });

  it("a declared openai-effort format is pinned the same way", async () => {
    const h = harness([finish()], "openai", undefined, "openai-effort");
    await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "high" } }, tools);
    expect(h.calls[0]!.providerOptions).toEqual({ openai: { reasoningEffort: "none" } });
  });

  it("the responses wire keeps reasoning together with tools", async () => {
    const h = harness([finish()], "openai", "openai-responses");
    await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "medium" } }, tools);
    expect(h.calls[0]!.providerOptions).toEqual({ openai: { reasoningEffort: "medium", store: false } });
  });

  it("a non-OpenAI chat backend still sends the requested effort with tools", async () => {
    // `custom` is the openai-compat posture (an arbitrary OpenAI-shaped host).
    // Declared `openai-effort` formats included: the pin is the openai kind's.
    for (const kind of ["opencode", "openrouter", "custom"] as const) {
      const h = harness([finish()], kind, "openai-chat", "openai-effort");
      await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "high" } }, tools);
      expect(h.calls[0]!.providerOptions).toEqual({ openai: { reasoningEffort: "high" } });
    }
  });

  // The seam above asserts what moh hands the SDK. These close the loop on
  // the wire: the real adapter path, a stubbed fetch, and the body the
  // request actually carries — the combination the API refused.
  async function requestFor(target: RouteTarget, options?: StreamOptions) {
    const calls: { url: string; body: any }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.url, body: JSON.parse(String(init?.body)) });
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "c1", created: 1, model: "m", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    try {
      const events: StreamEvent[] = [];
      for await (const e of aiSdkStreamFor(target, "k", undefined)(
        [{ role: "user", parts: [{ kind: "text", text: "prova gpt" }] }],
        new AbortController().signal,
        tools,
        options,
      )) events.push(e);
      return { url: calls[0]!.url, body: calls[0]!.body, start: events[0] };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const apiKeyTarget = (thinkingFormat?: import("../src/types").ThinkingFormat): RouteTarget => ({
    endpoint: new Endpoint({ name: "openai", kind: "openai", apiKey: "k", baseUrl: "https://api.openai.com/v1" }),
    modelId: "gpt-6-luna",
    ...(thinkingFormat ? { thinkingFormat } : {}),
  });

  it("a model moh has no metadata for sends none with its tools, and announces no level", async () => {
    // The reported case: no catalog row, no resolved level, tools in play.
    const sent = await requestFor(apiKeyTarget());
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent.body.reasoning_effort).toBe("none");
    expect(sent.body.tools).toHaveLength(1);
    expect(sent.start).toMatchObject({ type: "model_call_start", wire: "openai-chat" });
    expect(sent.start).not.toHaveProperty("thinkingLevel");
  });

  it("a declared openai-effort level is pinned on the wire, and the audit says what was sent", async () => {
    const sent = await requestFor(apiKeyTarget("openai-effort"), { thinking: { level: "medium" } });
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent.body.reasoning_effort).toBe("none");
    expect(sent.body.tools).toHaveLength(1);
    expect(sent.start).toMatchObject({ type: "model_call_start", wire: "openai-chat", thinkingLevel: "off" });
  });

  it("without tools the requested level is untouched", async () => {
    const h = harness([finish()], "openai");
    await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], { thinking: { level: "medium" } });
    expect(h.calls[0]!.providerOptions).toEqual({ openai: { reasoningEffort: "medium" } });
  });
});
