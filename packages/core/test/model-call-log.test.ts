import { describe, expect, test } from "bun:test";
import { createRoute, createSession, Endpoint, MockProvider, replayMessages, ProviderError } from "../src/index";
import type { AgentEvent, Message, Provider, RouteTarget, StreamEvent } from "../src/index";

/**
 * #83 (option 3): every model call is recorded in the event log — a
 * `model_call` event per call (model + token usage) plus a cumulative
 * usage rollup on `done`. New events are chrome for replay: older
 * readers ignore them and `#messages` reconstruction is unchanged.
 */

describe("model_call logging (#83)", () => {
  test("one model_call event per provider call, with per-call usage; done carries the rollup", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["let me check"], finish: "tool_calls", toolCalls: [{ name: "echo", args: {} }], usage: { inputTokens: 10, outputTokens: 5 } },
      { deltas: ["all done"], finish: "stop", usage: { inputTokens: 20, outputTokens: 8 } },
    ]);
    const session = createSession({ provider, tools: { echo: { name: "echo", description: "", async run() { return "ok"; } } as never } });
    void (async () => {
      for await (const _ of session.events) void _;
    })();
    const result = await session.send("go");
    expect(result.status).toBe("done");

    const modelCalls = session.history().filter((e) => e.type === "model_call");
    expect(modelCalls).toHaveLength(2);
    expect(modelCalls[0]).toEqual({ type: "model_call", model: "mock", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(modelCalls[1]).toEqual({ type: "model_call", model: "mock", usage: { inputTokens: 20, outputTokens: 8 } });

    const done = session.history().at(-1);
    expect(done).toEqual({ type: "done", usage: { inputTokens: 30, outputTokens: 13 } });
  });

  test("replay ignores model_call events: replayMessages is unchanged", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "v1" },
      { type: "user_message", text: "hi" },
      { type: "model_call", model: "gw/auto", usage: { inputTokens: 3, outputTokens: 4 } },
      { type: "assistant_delta", text: "yo" },
      { type: "done", usage: { inputTokens: 3, outputTokens: 4 } },
    ];
    const without = replayMessages(events.filter((e) => e.type !== "model_call"));
    expect(replayMessages(events)).toEqual(without);
  });

  test("route announces each attempt as a model_call stream event (primary ref, then fallback)", async () => {
    const endpoint = new Endpoint({ name: "gw", kind: "mock" });
    const target: RouteTarget = { endpoint, modelId: "auto" };
    const fb: RouteTarget = { endpoint: new Endpoint({ name: "direct", kind: "mock" }), modelId: "glm-4.6" };
    // Primary fails mid-stream (quota); fallback serves the turn.
    const route = createRoute({
      target,
      fallbacks: [fb],
      retries: 0,
      retryBackoffMs: 0,
      createStream: (t) => {
        if (t === target) {
          return (async function* (): AsyncIterable<StreamEvent> {
            yield { type: "text_delta", text: "half" };
            throw new ProviderError("quota_exhausted", "no balance");
          }) as never;
        }
        const mock = MockProvider.scripted([{ deltas: ["recovered"], finish: "stop" }]);
        return (messages: Message[], signal: AbortSignal) => mock.stream(messages, signal);
      },
    });
    const seen: string[] = [];
    for await (const event of route.stream([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], AbortSignal.timeout(2000))) {
      if (event.type === "model_call") seen.push(event.model);
    }
    // The failed attempt and the fallback are both announced (the mock
    // fallback provider announces itself too — it is a model call).
    expect(seen).toEqual(["gw/auto", "direct/glm-4.6", "mock"]);
  });
});
