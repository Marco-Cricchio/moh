import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, MockProvider } from "../src/index";
import type { AgentSession, Provider } from "../src/index";
import { ProviderError } from "../src/types";
import type { AgentEvent, Message, StreamEvent, ToolSpec } from "../src/types";

/**
 * #1442 characterization: the two stream-consumption loops of `AgentLoop`
 * (the main iteration and the iteration-cap wrap-up) pinned event by event
 * — order, keys, messages and abort points — before they share one routine.
 */

type Call = (ctx: { abort: () => void; tools: readonly ToolSpec[] }) => AsyncGenerator<StreamEvent>;

/** A provider that serves one generator per call (the last repeats) and
 * records the tool specs and messages each call received. */
function scripted(calls: Call[]): Provider & { seen: { tools: readonly ToolSpec[]; messages: Message[] }[]; bind(s: AgentSession): void } {
  let session: AgentSession | undefined;
  let n = 0;
  const seen: { tools: readonly ToolSpec[]; messages: Message[] }[] = [];
  return {
    name: "scripted",
    seen,
    bind(s: AgentSession) {
      session = s;
    },
    async *stream(messages: Message[], _signal: AbortSignal, tools?: readonly ToolSpec[]) {
      const call = calls[Math.min(n, calls.length - 1)]!;
      n += 1;
      seen.push({ tools: tools ?? [], messages: structuredClone(messages) });
      yield* call({ abort: () => session!.abort(), tools: tools ?? [] });
    },
  };
}

/** First call: one tool round trip (`bash` is not registered here, so it
 * settles as an unknown-tool result), so `maxIterations: 1` reaches the wrap-up. */
const toolRound: Call = async function* () {
  yield { type: "model_call_start", model: "m" };
  yield { type: "tool_calls", calls: [{ callId: "c1", name: "bash", args: { command: "true" } }] };
  yield { type: "finish", reason: "tool_calls" };
};

function open(calls: Call[], maxIterations = 1) {
  const provider = scripted(calls);
  const session = createSession({ provider, maxIterations });
  provider.bind(session);
  return { provider, session };
}

/** The events after the turn's last `tool_result` (the wrap-up portion), or
 * after `user_message` when the turn ran no tool. */
function tail(session: AgentSession): AgentEvent[] {
  const log = session.history();
  let start = log.map((e) => e.type).lastIndexOf("tool_result");
  if (start === -1) start = log.map((e) => e.type).lastIndexOf("user_message");
  return log.slice(start + 1);
}

/** The observable shape of an event: type plus the keys the contract names. */
function shape(e: AgentEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { type: e.type };
  const r = e as unknown as Record<string, unknown>;
  for (const k of ["text", "reason", "message", "failed", "from", "to", "selected", "serving", "previous", "model", "window"]) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  if (e.type === "model_call") {
    out.usage = e.usage;
    out.outcome = e.attempt?.outcome;
    if (e.attempt?.errorKind !== undefined) out.errorKind = e.attempt.errorKind;
  }
  if (e.type === "done") out.usage = e.usage;
  return out;
}

describe("AgentLoop wrap-up stream consumption (#1442 characterization)", () => {
  test("fallback then route_serving inside the wrap-up: exact event order", async () => {
    const { session, provider } = open([
      toolRound,
      async function* () {
        yield { type: "model_call_start", model: "a" };
        yield { type: "fallback", from: "a", to: "b", reason: "quota_exhausted" };
        yield { type: "model_call_start", model: "b" };
        yield { type: "text_delta", text: "wrapped " };
        yield { type: "route_serving", selected: "a", serving: "b", previous: "a" };
        yield { type: "text_delta", text: "up" };
        yield { type: "usage", inputTokens: 3, outputTokens: 2 };
        yield { type: "finish", reason: "stop" };
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "done" });
    expect(provider.seen[1]!.tools).toEqual([]);
    expect(tail(session).map(shape)).toEqual([
      { type: "fallback", from: "a", to: "b", reason: "quota_exhausted" },
      { type: "model_call", model: "a", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "failed", errorKind: "quota_exhausted" },
      { type: "quota_observation", model: "a" },
      { type: "quota_episode" },
      { type: "assistant_delta", text: "wrapped " },
      { type: "route_serving", selected: "a", serving: "b", previous: "a" },
      { type: "assistant_delta", text: "up" },
      { type: "model_call", model: "b", usage: { inputTokens: 3, outputTokens: 2 }, outcome: "completed" },
      { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    // The wrap-up text is the turn's closing assistant message.
    await session.send("next");
    const last = provider.seen.at(-1)!.messages;
    expect(last.at(-2)).toEqual({ role: "assistant", parts: [{ kind: "text", text: "wrapped up" }] });
  });

  test("reasoning inside the wrap-up lands before its model_call and rides the closing message", async () => {
    const { session, provider } = open([
      toolRound,
      async function* () {
        yield { type: "model_call_start", model: "m" };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "pondering" };
        yield { type: "reasoning_end", continuation: { sig: "x" } };
        yield { type: "text_delta", text: "summary" };
        yield { type: "finish", reason: "stop" };
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "done" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "summary" },
      { type: "reasoning", text: "pondering" },
      { type: "model_call", model: "m", usage: { inputTokens: 0, outputTokens: 0 }, outcome: "completed" },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    expect((tail(session).find((e) => e.type === "reasoning") as { continuation?: unknown }).continuation).toEqual({ sig: "x" });
    await session.send("next");
    expect(provider.seen.at(-1)!.messages.at(-2)).toEqual({
      role: "assistant",
      parts: [
        { kind: "reasoning", text: "pondering", continuation: { sig: "x" } },
        { kind: "text", text: "summary" },
      ],
    });
  });

  test("a context_length refusal during the wrap-up: failed call, window learned, the cap error", async () => {
    const { session } = open([
      toolRound,
      async function* () {
        yield { type: "model_call_start", model: "m" };
        yield { type: "text_delta", text: "partial" };
        throw new ProviderError("context_length", "the maximum context length is 131072 tokens", 131072);
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "error", reason: "max_iterations", message: "iteration cap reached" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "partial" },
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "failed", errorKind: "context_length" },
      { type: "declared_window", model: "m", window: 131072 },
      { type: "error", reason: "max_iterations", message: "iteration cap of 1 reached" },
    ]);
  });

  test("a non-refusal failure during the wrap-up teaches nothing and still ends as the cap error", async () => {
    const { session } = open([
      toolRound,
      async function* () {
        yield { type: "model_call_start", model: "m" };
        throw new ProviderError("network", "socket hang up");
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "error", reason: "max_iterations", message: "iteration cap reached" });
    expect(tail(session).map(shape)).toEqual([
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "failed", errorKind: "network" },
      { type: "error", reason: "max_iterations", message: "iteration cap of 1 reached" },
    ]);
  });

  test("a wrap-up stream that ends without finish is cancelled, its call discarded", async () => {
    const { session } = open([
      toolRound,
      async function* () {
        yield { type: "model_call_start", model: "m" };
        yield { type: "text_delta", text: "cut" };
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "cancelled" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "cut" },
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "aborted" },
      { type: "cancelled" },
    ]);
  });

  test("an abort mid wrap-up stream stops consumption at the next event", async () => {
    const { session } = open([
      toolRound,
      async function* ({ abort }) {
        yield { type: "model_call_start", model: "m" };
        yield { type: "text_delta", text: "before" };
        abort();
        yield { type: "text_delta", text: "after" };
        yield { type: "finish", reason: "stop" };
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "cancelled" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "before" },
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "aborted" },
      { type: "cancelled" },
    ]);
  });

  test("an empty completion is done in the wrap-up but an error in the main loop", async () => {
    const empty: Call = async function* () {
      yield { type: "model_call_start", model: "m" };
      yield { type: "usage", inputTokens: 0, outputTokens: 0 };
      yield { type: "finish", reason: "stop" };
    };
    const wrap = open([toolRound, empty]).session;
    expect(await wrap.send("go")).toEqual({ status: "done" });
    expect(tail(wrap).map(shape)).toEqual([
      { type: "model_call", model: "m", usage: { inputTokens: 0, outputTokens: 0 }, outcome: "completed" },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    const main = open([empty], 5).session;
    const message = "scripted returned an empty completion (no content, no tool calls, no usage)";
    expect(await main.send("go")).toEqual({ status: "error", reason: "empty_completion", message });
    expect(tail(main).map(shape)).toEqual([
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "failed", errorKind: "empty_completion" },
      { type: "error", reason: "empty_completion", message },
    ]);
  });

  test("tool calls streamed during the wrap-up are ignored", async () => {
    const { session, provider } = open([
      toolRound,
      toolRound,
      async function* () {
        yield { type: "model_call_start", model: "m" };
        yield { type: "text_delta", text: "fresh" };
        yield { type: "finish", reason: "stop" };
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "done" });
    expect(tail(session).map(shape)).toEqual([
      { type: "model_call", model: "m", usage: { inputTokens: 0, outputTokens: 0 }, outcome: "completed" },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    await session.send("next");
    expect(provider.seen.at(-1)!.messages.at(-2)).toEqual({ role: "assistant", parts: [{ kind: "text", text: "" }] });
  });
});

describe("AgentLoop main stream consumption under abort (#1442 characterization)", () => {
  test("an abort then a throw mid-stream: cancelled, no error event", async () => {
    const { session } = open(
      [
        async function* ({ abort }) {
          yield { type: "model_call_start", model: "m" };
          yield { type: "text_delta", text: "half" };
          abort();
          throw new ProviderError("network", "aborted read");
        },
      ],
      5,
    );
    expect(await session.send("go")).toEqual({ status: "cancelled" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "half" },
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "aborted" },
      { type: "cancelled" },
    ]);
  });

  test("finish then an abort and a throw: the partial stream state still decides the turn", async () => {
    const { session, provider } = open(
      [
        async function* ({ abort }) {
          yield { type: "model_call_start", model: "m" };
          yield { type: "text_delta", text: "done-ish" };
          yield { type: "finish", reason: "stop" };
          abort();
          throw new ProviderError("network", "aborted after finish");
        },
        async function* () {
          yield { type: "model_call_start", model: "m" };
          yield { type: "text_delta", text: "second" };
          yield { type: "finish", reason: "stop" };
        },
      ],
      5,
    );
    expect(await session.send("go")).toEqual({ status: "cancelled" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "done-ish" },
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "aborted" },
      { type: "cancelled" },
    ]);
    await session.send("next");
    expect(provider.seen.at(-1)!.messages.slice(1).map((m) => m.role)).toEqual(["user", "user"]);
  });

  test("finish with tool calls then an abort and a throw: the tool round still runs on the aborted signal", async () => {
    const { session, provider } = open(
      [
        async function* ({ abort }) {
          yield { type: "model_call_start", model: "m" };
          yield { type: "text_delta", text: "calling" };
          yield { type: "tool_calls", calls: [{ callId: "c9", name: "bash", args: { command: "true" } }] };
          yield { type: "finish", reason: "tool_calls" };
          abort();
          throw new ProviderError("network", "aborted after finish");
        },
        async function* () {
          yield { type: "model_call_start", model: "m" };
          yield { type: "text_delta", text: "second" };
          yield { type: "finish", reason: "stop" };
        },
      ],
      5,
    );
    expect(await session.send("go")).toEqual({ status: "cancelled" });
    const log = session.history();
    const turn = log.slice(log.map((e) => e.type).lastIndexOf("user_message") + 1);
    expect(turn.map(shape)).toEqual([
      { type: "assistant_delta", text: "calling" },
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "aborted" },
      { type: "tool_call" },
      { type: "tool_result" },
      { type: "cancelled" },
    ]);
    await session.send("next");
    expect(provider.seen.at(-1)!.messages.slice(1).map((m) => [m.role, m.parts.map((p) => p.kind)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["text", "tool_call"]],
      ["user", ["tool_result"]],
      ["user", ["text"]],
    ]);
  });

  test("an abort right after finish (no throw) discards the call and cancels", async () => {
    const { session } = open(
      [
        async function* ({ abort }) {
          yield { type: "model_call_start", model: "m" };
          yield { type: "text_delta", text: "complete" };
          yield { type: "finish", reason: "stop" };
          abort();
          yield { type: "usage", inputTokens: 1, outputTokens: 1 };
        },
      ],
      5,
    );
    expect(await session.send("go")).toEqual({ status: "cancelled" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "complete" },
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "aborted" },
      { type: "cancelled" },
    ]);
  });
});

/** Events outside the `StreamEvent` type, as an untyped (plain-JS or
 * cassette) provider can produce them. */
const untyped = (event: Record<string, unknown>): StreamEvent => event as unknown as StreamEvent;

describe("AgentLoop stream consumption with out-of-type events (#1442 review)", () => {
  test("a wrap-up finish with reason null still finishes the wrap-up", async () => {
    const { session } = open([
      toolRound,
      async function* () {
        yield { type: "model_call_start", model: "m" };
        yield { type: "text_delta", text: "wrap" };
        yield untyped({ type: "finish", reason: null });
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "done" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "wrap" },
      { type: "model_call", model: "m", usage: { inputTokens: 0, outputTokens: 0 }, outcome: "completed" },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  test("a wrap-up finish stop followed by a finish null still finishes the wrap-up", async () => {
    const { session } = open([
      toolRound,
      async function* () {
        yield { type: "model_call_start", model: "m" };
        yield { type: "text_delta", text: "wrap" };
        yield { type: "finish", reason: "stop" };
        yield untyped({ type: "finish", reason: null });
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "done" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "wrap" },
      { type: "model_call", model: "m", usage: { inputTokens: 0, outputTokens: 0 }, outcome: "completed" },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  test("a cassette wrap-up turn with finish null is done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-1442-"));
    try {
      const file = join(dir, "cassette.json");
      writeFileSync(
        file,
        JSON.stringify([
          { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: {} }] },
          { deltas: ["wrap"], finish: null },
        ]),
      );
      const session = createSession({ provider: MockProvider.cassette(file), maxIterations: 1 });
      expect(await session.send("go")).toEqual({ status: "done" });
      expect(tail(session).map(shape)).toEqual([
        { type: "assistant_delta", text: "wrap" },
        { type: "model_call", model: "mock", usage: { inputTokens: 0, outputTokens: 0 }, outcome: "completed" },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wrap-up tool_calls event without calls is ignored", async () => {
    const { session } = open([
      toolRound,
      async function* () {
        yield { type: "model_call_start", model: "m" };
        yield untyped({ type: "tool_calls" });
        yield { type: "text_delta", text: "w" };
        yield { type: "finish", reason: "stop" };
      },
    ]);
    expect(await session.send("go")).toEqual({ status: "done" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "w" },
      { type: "model_call", model: "m", usage: { inputTokens: 0, outputTokens: 0 }, outcome: "completed" },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  test("the main loop still cancels on a finish with reason null", async () => {
    const { session } = open(
      [
        async function* () {
          yield { type: "model_call_start", model: "m" };
          yield { type: "text_delta", text: "main" };
          yield untyped({ type: "finish", reason: null });
        },
      ],
      5,
    );
    expect(await session.send("go")).toEqual({ status: "cancelled" });
    expect(tail(session).map(shape)).toEqual([
      { type: "assistant_delta", text: "main" },
      { type: "model_call", model: "m", failed: true, usage: { inputTokens: 0, outputTokens: 0 }, outcome: "aborted" },
      { type: "cancelled" },
    ]);
  });

  test("the main loop still fails on a tool_calls event without calls", async () => {
    const { session } = open(
      [
        async function* () {
          yield { type: "model_call_start", model: "m" };
          yield untyped({ type: "tool_calls" });
          yield { type: "finish", reason: "stop" };
        },
      ],
      5,
    );
    const result = await session.send("go");
    expect(result.status).toBe("error");
    expect((result as { reason?: string }).reason).toBe("provider_failure");
    const events = tail(session).map(shape);
    expect(events.map((e) => e.type)).toEqual(["model_call", "error"]);
    expect(events[0]).toMatchObject({ failed: true, outcome: "failed" });
    expect(events[1]).toMatchObject({ reason: "provider_failure" });
  });
});
