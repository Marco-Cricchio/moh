import { describe, expect, it } from "bun:test";
import { simulateReadableStream } from "ai/test";
import { aiSdkStreamFor } from "../src/providers/ai-sdk";
import { Endpoint, type RouteTarget } from "../src/route";
import type { LanguageModel } from "ai";
import type { Message, StreamEvent } from "../src/types";

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

function harness(parts: StreamPart[], kind: ConstructorParameters<typeof Endpoint>[0]["kind"] = "openai", wire?: import("../src/wire").WireApi) {
  const calls: any[] = [];
  const target: RouteTarget = {
    endpoint: new Endpoint({ name: "t", kind, apiKey: "k" }),
    modelId: "m",
    ...(wire ? { wire } : {}),
  };
  const stream = aiSdkStreamFor(target, "k", undefined, mockModel(parts, calls));
  return {
    calls,
    run: async (messages: Message[], options?: import("../src/types").StreamOptions): Promise<StreamEvent[]> => {
      const events: StreamEvent[] = [];
      for await (const e of stream(messages, new AbortController().signal, undefined, options)) events.push(e);
      return events;
    },
  };
}

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
      { type: "model_call_start", model: "t/m" },
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "step one. " },
      { type: "reasoning_delta", text: "step two." },
      { type: "reasoning_end", continuation: { anthropic: { signature: "sig-9" } } },
      { type: "text_delta", text: "answer" },
      { type: "usage", inputTokens: 1, outputTokens: 2 },
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
    expect(events[0]).toEqual({ type: "model_call_start", model: "t/m", thinkingLevel: "high" });
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
    expect(events[0]).toEqual({ type: "model_call_start", model: "t/m" });
  });

  it("no thinking option sends no providerOptions at all", async () => {
    const h = harness([finish()], "openai");
    await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }]);
    expect(h.calls[0]!.providerOptions).toBeUndefined();
  });
});
