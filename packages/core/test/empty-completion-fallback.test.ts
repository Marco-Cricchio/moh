import { describe, expect, it, test } from "bun:test";
import { simulateReadableStream } from "ai/test";
import { MockProvider, createSession, type Provider } from "../src/index";
import { createRoute, Endpoint, envApiKey } from "../src/route";
import { ProviderError } from "../src/types";
import type { Message, StreamEvent } from "../src/types";
import type { RouteTarget } from "../src/route";
import { aiSdkStreamFor } from "../src/providers/ai-sdk";
import type { LanguageModel } from "ai";

function mockEndpoint(name: string): Endpoint {
  return new Endpoint({ name, kind: "mock" });
}

function mockTarget(name: string): RouteTarget {
  return { endpoint: mockEndpoint(name), modelId: `model-${name}` };
}

const userTurn: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];

describe("empty completion is a provider failure (#853)", () => {
  test("an empty completion drives a fallback: the next target serves the turn", async () => {
    const empty = MockProvider.scripted([{ deltas: [], finish: "stop", usage: { inputTokens: 0, outputTokens: 0 } }]);
    const recovery = MockProvider.scripted([{ deltas: ["real answer"], finish: "stop" }]);
    const streams = [
      (m: Message[], s: AbortSignal) => empty.stream(m, s),
      (m: Message[], s: AbortSignal) => recovery.stream(m, s),
    ];
    let idx = 0;
    const route = createRoute({
      target: mockTarget("a"),
      fallbacks: [mockTarget("b")],
      retries: 0,
      retryBackoffMs: 0,
      createStream: () => {
        const stream = streams[idx]!;
        idx += 1;
        return stream;
      },
    });
    const events: StreamEvent[] = [];
    for await (const e of route.stream(userTurn, new AbortController().signal)) events.push(e);
    expect(idx).toBe(2); // the chain was walked
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("real answer");
    expect(events).toContainEqual({ type: "fallback", from: "a/model-a", to: "b/model-b", reason: "empty_completion" });
    expect(events).toContainEqual({ type: "route_serving", selected: "a/model-a", previous: "a/model-a", serving: "b/model-b" });
  });

  test("an exhausted chain ends the turn with a visible classified error, never a silent empty done", async () => {
    const empty = MockProvider.scripted([{ deltas: [], finish: "stop", usage: { inputTokens: 0, outputTokens: 0 } }]);
    const route = createRoute({
      target: mockTarget("solo"),
      retries: 0,
      createStream: () => (m: Message[], s: AbortSignal) => empty.stream(m, s),
    });
    const events: StreamEvent[] = [];
    let thrown: unknown;
    try {
      for await (const e of route.stream(userTurn, new AbortController().signal)) events.push(e);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    const pe = thrown as ProviderError;
    expect(pe.kind).toBe("empty_completion");
    expect(pe.message).toContain("solo/model-solo"); // names the target that produced nothing
  });

  test("a real zero-cost call (non-empty text, zero usage) is NOT a failure", async () => {
    const zeroCost = MockProvider.scripted([{ deltas: ["ok"], finish: "stop", usage: { inputTokens: 0, outputTokens: 0 } }]);
    const route = createRoute({
      target: mockTarget("a"),
      retries: 0,
      createStream: () => (m: Message[], s: AbortSignal) => zeroCost.stream(m, s),
    });
    let thrown: unknown;
    try {
      for await (const _ of route.stream(userTurn, new AbortController().signal)) { /* consume */ }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
  });

  test("tool calls alone count as usable output (finish tool_calls, zero usage)", async () => {
    const toolOnly = MockProvider.scripted([{ deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: {} }] }]);
    const route = createRoute({
      target: mockTarget("a"),
      retries: 0,
      createStream: () => (m: Message[], s: AbortSignal) => toolOnly.stream(m, s),
    });
    let thrown: unknown;
    try {
      for await (const _ of route.stream(userTurn, new AbortController().signal)) { /* consume */ }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
  });

  test("the ai-sdk adapter surfaces a finished-but-empty stream as plain events; the route classifies it", async () => {
    const calls: any[] = [];
    const model = {
      specificationVersion: "v4",
      provider: "mock",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 }, totalTokens: 0 },
            },
          ],
        }),
      }),
    } as unknown as LanguageModel;
    const target: RouteTarget = {
      endpoint: new Endpoint({ name: "t-openai", kind: "openai", apiKey: "k" }),
      modelId: "m",
    };
    const stream = aiSdkStreamFor(target, "k", undefined, model);
    const events: StreamEvent[] = [];
    let thrown: unknown;
    try {
      for await (const e of stream(userTurn, new AbortController().signal)) events.push(e);
    } catch (err) {
      thrown = err;
    }
    // The adapter stays neutral — one announcement, one usage, one finish.
    expect(thrown).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["model_call_start", "usage", "finish"]);
    // The route turns that same stream into a classified failure.
    const route = createRoute({
      target,
      retries: 0,
      createStream: () => (m: Message[], s: AbortSignal) => stream(m, s),
    });
    let routeErr: unknown;
    try {
      for await (const _ of route.stream(userTurn, new AbortController().signal)) { /* consume */ }
    } catch (err) {
      routeErr = err;
    }
    expect(routeErr).toBeInstanceOf(ProviderError);
    expect((routeErr as ProviderError).kind).toBe("empty_completion");
    expect((routeErr as ProviderError).message).toContain("t-openai/m"); // names the target that produced nothing
  });
});
