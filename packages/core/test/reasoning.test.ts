import { describe, expect, test } from "bun:test";
import { createSession, MockProvider } from "../src/index";
import { replayMessages } from "../src/session-store";
import { createRoute, Endpoint } from "../src/route";
import type { AgentEvent, Message, StreamEvent, StreamOptions, ThinkingLevel } from "../src/types";

/**
 * #240: provider reasoning stream + neutral thinking-level requests.
 * Completed reasoning is `AgentEvent` data (persisted, replayed into the
 * provider context); interrupted calls keep no partial reasoning; the
 * `model_call` audit records the effective thinking level.
 */

function drain(session: { events: AsyncIterable<AgentEvent> }) {
  void (async () => {
    for await (const _ of session.events) void _;
  })();
}

const REASONING = { deltas: ["step 1: parse. ", "step 2: answer."], continuation: { signature: "sig-1" } };

describe("reasoning persistence and replay (#240)", () => {
  test("completed reasoning is persisted once per call, before model_call, with continuation metadata", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["the answer"], finish: "stop", reasoning: REASONING, usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
    const session = createSession({ provider });
    drain(session);
    await session.send("hi");
    const history = session.history();
    const i = history.findIndex((e) => e.type === "model_call");
    expect(history[i - 1]).toEqual({ type: "reasoning", text: "step 1: parse. step 2: answer.", continuation: { signature: "sig-1" } });
    expect(history[i]).toEqual({ type: "model_call", model: "mock", usage: { inputTokens: 1, outputTokens: 2 } });
  });

  test("replay reconstructs the reasoning part in the assistant message context", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "v1" },
      { type: "user_message", text: "hi" },
      { type: "reasoning", text: "thinking hard", continuation: { signature: "s" } },
      { type: "model_call", model: "mock", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "assistant_delta", text: "yo" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const messages = replayMessages(events);
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      parts: [
        { kind: "reasoning", text: "thinking hard", continuation: { signature: "s" } },
        { kind: "text", text: "yo" },
      ],
    });
  });

  test("a call emitting several reasoning blocks persists all of them (no overwrite)", async () => {
    const provider = {
      name: "multi-block",
      async *stream(_m: Message[], _s: AbortSignal): AsyncIterable<StreamEvent> {
        yield { type: "model_call_start", model: "multi-block" };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "first block" };
        yield { type: "reasoning_end", continuation: { signature: "a" } };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "second block" };
        yield { type: "reasoning_end" };
        yield { type: "text_delta", text: "answer" };
        yield { type: "finish", reason: "stop" as const };
      },
    };
    const session = createSession({ provider });
    drain(session);
    await session.send("hi");
    const blocks = session.history().filter((e) => e.type === "reasoning");
    expect(blocks).toEqual([
      { type: "reasoning", text: "first block", continuation: { signature: "a" } },
      { type: "reasoning", text: "second block" },
    ]);
    const last = replayMessages(session.history()).at(-1)!;
    expect(last.parts.slice(0, 2)).toEqual([
      { kind: "reasoning", text: "first block", continuation: { signature: "a" } },
      { kind: "reasoning", text: "second block" },
    ]);
  });

  test("a live multi-iteration turn attaches each call's reasoning to its own assistant message", async () => {
    const provider = MockProvider.scripted([
      {
        deltas: ["checking"],
        finish: "tool_calls",
        toolCalls: [{ name: "echo", args: {} }],
        reasoning: { deltas: ["plan"] },
      },
      { deltas: ["done"], finish: "stop", reasoning: { deltas: ["verify"] } },
    ]);
    const session = createSession({
      provider,
      tools: { echo: { name: "echo", description: "", execute: () => "ok" } as never },
    });
    drain(session);
    await session.send("go");
    const messages = replayMessages(session.history());
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0].parts[0]).toEqual({ kind: "reasoning", text: "plan" });
    expect(assistants[1].parts[0]).toEqual({ kind: "reasoning", text: "verify" });
  });

  test("an aborted mid-reasoning call keeps no partial reasoning in the replayed context", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["never arrives"], finish: "stop", deltaDelayMs: 50, reasoning: { deltas: ["half ", "thoughts"] } },
    ]);
    const session = createSession({ provider });
    drain(session);
    const p = session.send("hi");
    await Bun.sleep(60); // mid-reasoning, before any text delta
    session.abort();
    const result = await p;
    expect(result.status).toBe("cancelled");
    const messages = replayMessages(session.history());
    // No assistant message at all — nothing partial became a valid reply.
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(messages.some((m) => m.parts.some((p2) => p2.kind === "reasoning"))).toBe(false);
  });

  test("a failed call retains its completed reasoning block, before the error event", async () => {
    const provider = MockProvider.scripted([
      { deltas: [], finish: "stop", reasoning: { deltas: ["I was thinking"] }, error: { kind: "overloaded", message: "busy", afterDeltas: 0 } },
    ]);
    const session = createSession({ provider });
    drain(session);
    const result = await session.send("hi");
    expect(result.status).toBe("error");
    const history = session.history();
    const reasoning = history.find((e) => e.type === "reasoning");
    expect(reasoning).toEqual({ type: "reasoning", text: "I was thinking" });
    expect(history.findIndex((e) => e.type === "error")).toBeGreaterThan(history.indexOf(reasoning!));
    // And the reasoning stays out of the reconstructed context (no assistant message formed).
    expect(replayMessages(history).filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  test("providers without reasoning behave unchanged and receive no invented events", async () => {
    const provider = MockProvider.scripted([{ deltas: ["plain"], finish: "stop" }]);
    const session = createSession({ provider });
    drain(session);
    await session.send("hi");
    expect(session.history().some((e) => e.type === "reasoning")).toBe(false);
  });
});

describe("thinking-level request options (#240)", () => {
  test("a custom provider receives the neutral thinking option without any SDK type", async () => {
    let received: StreamOptions | undefined;
    const provider = {
      name: "custom-reasoner",
      async *stream(_m: Message[], _s: AbortSignal, _t?: never, options?: StreamOptions): AsyncIterable<StreamEvent> {
        received = options;
        yield { type: "model_call_start", model: "custom-reasoner", thinkingLevel: options?.thinking?.level };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "hmm" };
        yield { type: "reasoning_end" };
        yield { type: "text_delta", text: "ok" };
        yield { type: "finish", reason: "stop" as const };
      },
    };
    const session = createSession({ provider, thinking: { level: "high" } });
    drain(session);
    await session.send("hi");
    expect(received).toEqual({ thinking: { level: "high" } });
    // Effective-level audit (#239 decision 9): model_call carries what the provider announced.
    const call = session.history().find((e) => e.type === "model_call") as never as { thinkingLevel?: ThinkingLevel };
    expect(call.thinkingLevel).toBe("high");
    expect(session.history()).toContainEqual({ type: "reasoning", text: "hmm" });
  });

  test("no thinking option means no invented request field", async () => {
    let received: StreamOptions | undefined;
    const provider = {
      name: "plain",
      async *stream(_m: Message[], _s: AbortSignal, _t?: never, options?: StreamOptions): AsyncIterable<StreamEvent> {
        received = options;
        yield { type: "model_call_start", model: "plain" };
        yield { type: "text_delta", text: "hi" };
        yield { type: "finish", reason: "stop" as const };
      },
    };
    const session = createSession({ provider });
    drain(session);
    await session.send("go");
    expect(received).toBeUndefined();
    const call = session.history().find((e) => e.type === "model_call") as never as { thinkingLevel?: ThinkingLevel };
    expect(call.thinkingLevel).toBeUndefined();
  });

  test("a retry after a failure re-announces the thinking level; each model_call records it", async () => {
    const provider = MockProvider.scripted([
      { deltas: [], finish: "stop", error: { kind: "rate_limited", message: "slow down" } },
      { deltas: ["second try"], finish: "stop" },
    ]);
    const route = createRoute({
      target: { endpoint: new Endpoint({ name: "gw", kind: "mock" }), modelId: "m" },
      retries: 1,
      retryBackoffMs: 0,
      createStream: () => (messages, signal, tools, options) => provider.stream(messages, signal, tools, options),
    });
    const session = createSession({ provider: route, thinking: { level: "low" } });
    drain(session);
    await session.send("hi");
    const calls = session.history().filter((e) => e.type === "model_call") as never as { thinkingLevel?: ThinkingLevel }[];
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.thinkingLevel === "low")).toBe(true);
  });
});
