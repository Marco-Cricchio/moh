import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { createSession, MockProvider, type AgentEvent, type Provider } from "@moh/core";
import { projectTranscript } from "../src/transcript";
import { Chat, settledBoundary } from "../src/Chat";
import { stripAnsi } from "./helpers";

const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function drain(session: { events: AsyncIterable<unknown> }) {
  void (async () => {
    for await (const _ of session.events) void _;
  })();
}

/** Every reasoning block must sit above every prose block of the reply —
 * the pinned invariant under test (#326). */
function expectReasoningAboveReply(blocks: ReturnType<typeof projectTranscript>) {
  const kinds = blocks.map((block) => block.kind);
  const firstProse = kinds.indexOf("moh");
  const lastThinking = kinds.lastIndexOf("thinking");
  expect(lastThinking).toBeLessThan(firstProse);
}

/** #326: regression guard — the reasoning block always stays above the
 * LLM's reply, in every projection path. The reposition-below request was
 * withdrawn; these tests pin the current ordering so it cannot silently
 * regress.
 *
 * 1. Settled projection: reasoning precedes the reply's prose blocks.
 * 2. Multi-call turns: each call's reasoning stays above the reply, in
 *    log order.
 * 3. Promotion boundary: the sealed reasoning+model_call unit promotes
 *    into Static above the reply paragraphs that promote later.
 * 4. Live tail: the volatile live-reasoning block precedes the streaming
 *    reply text.
 * 5. Reprojection: a whole-transcript rebuild (display toggle / mode
 *    switch) keeps historical reasoning above the reply.
 */
describe("reasoning above the reply (#326)", () => {
  // Real log order (#240 flush): the call's deltas precede its
  // reasoning+model_call group; the projection reorders the group above.
  test("settled projection: the reasoning block precedes the reply's prose blocks", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "why?" },
      { type: "reasoning", text: "premise one\npremise two" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "assistant_delta", text: "first paragraph.\n\nsecond paragraph." },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, models: ["provider/model"] },
    ];
    const idealized = projectTranscript(events, { showReasoning: true });
    expectReasoningAboveReply(idealized);

    // Flush order (what the agent loop actually persists): deltas first.
    const flushed: AgentEvent[] = [
      { type: "user_message", text: "why?" },
      { type: "assistant_delta", text: "first paragraph.\n\nsecond paragraph." },
      { type: "reasoning", text: "premise one\npremise two" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, models: ["provider/model"] },
    ];
    const blocks = projectTranscript(flushed, { showReasoning: true });
    expectReasoningAboveReply(blocks);
    // The reply's paragraphs are separate prose blocks, all after the block.
    expect(blocks.filter((block) => block.kind === "moh" && block.markdown).length).toBe(2);
    // Failed calls keep their position: the error-state block stays in log
    // order beside its error, not reordered above the partial reply.
    const failed = projectTranscript([
      { type: "user_message", text: "try" },
      { type: "assistant_delta", text: "partial text" },
      { type: "reasoning", text: "doomed thought" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 0 }, failed: true },
      { type: "error", reason: "provider_failure", message: "boom" },
    ], { showReasoning: true });
    expect(failed.map((block) => block.kind)).toEqual(["user", "moh", "thinking", "error"]);
  });

  test("a same-model retry after fallback is not stained failed by the reorder", () => {
    // After the reorder the retry's group sits beside the fallback event:
    // the failed-detection must use the ORIGINAL log neighbor, so a retry
    // (even on the same model) stays clean when its call succeeded.
    const blocks = projectTranscript([
      { type: "user_message", text: "retry" },
      { type: "fallback", from: "provider/model", to: "provider/model", reason: "overloaded" },
      { type: "assistant_delta", text: "retry answer" },
      { type: "reasoning", text: "retry thought" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 3 } },
      { type: "done", usage: { inputTokens: 1, outputTokens: 3 }, models: ["provider/model"] },
    ], { showReasoning: true });
    const retry = blocks.find((block) => block.kind === "thinking")!;
    expect(retry.state).not.toBe("fail");
    expect(retry.detail).toBe("· provider/model");
    expectReasoningAboveReply(blocks);
  });

  test("multi-call fallback chain: each call's reasoning stays above the reply in log order", () => {
    // Real flush order: the failed call failed before any text; the backup
    // call's group flushes after its answer deltas and reorders above them.
    const events: AgentEvent[] = [
      { type: "user_message", text: "try twice" },
      { type: "reasoning", text: "primary attempt thought" },
      { type: "model_call", model: "primary/model", usage: { inputTokens: 1, outputTokens: 0 }, failed: true },
      { type: "fallback", from: "primary/model", to: "backup/model", reason: "overloaded" },
      { type: "assistant_delta", text: "the answer" },
      { type: "reasoning", text: "backup attempt thought" },
      { type: "model_call", model: "backup/model", usage: { inputTokens: 1, outputTokens: 5 } },
      { type: "done", usage: { inputTokens: 1, outputTokens: 5 }, models: ["backup/model"] },
    ];
    const blocks = projectTranscript(events, { showReasoning: true });
    expectReasoningAboveReply(blocks);
    // Both calls' reasoning blocks project, in call order, above the prose.
    const thinking = blocks.filter((block) => block.kind === "thinking");
    expect(thinking.map((block) => block.lines[0])).toEqual(["primary attempt thought", "backup attempt thought"]);
    expect(blocks.findIndex((block) => block.markdown === "the answer")).toBeGreaterThan(blocks.map((block) => block.kind).lastIndexOf("thinking"));
  });

  test("promotion boundary: the sealed reasoning unit promotes into Static above the reply paragraphs that promote later", () => {
    // Real flush order, mid-turn with the reply still streaming: the hold
    // (#326) keeps the whole open reply volatile — nothing of the call may
    // promote before its reasoning group exists.
    const streaming: AgentEvent[] = [
      { type: "user_message", text: "stream me an answer" },
      { type: "assistant_delta", text: "promoted paragraph.\n\nstill streaming" },
    ];
    expect(settledBoundary(streaming, true, { holdReplyForReasoning: true })).toBe(1);

    // The call seals (group flushed, tool call follows): run + group settle
    // together, and the settled projection puts the reasoning above the prose.
    const events: AgentEvent[] = [
      ...streaming,
      { type: "reasoning", text: "settled thought" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 0 } },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
    ];
    const boundary = settledBoundary(events, true, { holdReplyForReasoning: true });
    expect(boundary).toBe(4); // through the group, before the pending tool call
    const settled = projectTranscript(events.slice(0, boundary), { showReasoning: true });
    const volatile = projectTranscript(events.slice(boundary), { showReasoning: true });
    expect(settled.some((block) => block.kind === "thinking")).toBe(true);
    expect(settled.some((block) => block.kind === "moh")).toBe(true);
    expect(volatile.some((block) => block.kind === "tool")).toBe(true);
    // Assembled (Static above volatile), reasoning is above all prose —
    // and inside Static it sealed above the reply's paragraphs.
    expectReasoningAboveReply([...settled, ...volatile]);
    expect(settled.map((block) => block.kind).lastIndexOf("thinking")).toBeLessThan(settled.findIndex((block) => block.kind === "moh"));
  });

  // Streaming path is CORRECT today (#253): the live reasoning block leads
  // the volatile area above the streaming reply text. This is a hard pin.
  test("live tail: the volatile live-reasoning block precedes the streaming reply text", async () => {
    let releaseText: (() => void) | null = null;
    const textGate = new Promise<void>((resolve) => {
      releaseText = resolve;
    });
    const stream = async function* () {
      yield { type: "model_call_start", model: "reasoner" };
      yield { type: "reasoning_start" };
      yield { type: "reasoning_delta", text: "live thinking above the answer" };
      yield { type: "reasoning_end" };
      yield { type: "text_delta", text: "streaming answer text" };
      await textGate;
      yield { type: "finish", reason: "stop" };
    };
    const provider: Provider = { name: "reasoner", stream: stream as Provider["stream"] };
    const session = createSession({ provider, memory: { enabled: false } });
    drain(session);
    const ui = render(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="reasoner" width={80} showReasoning />,
    );
    const done = session.send("think");
    await nap(150);
    const frame = stripAnsi(ui.lastFrame() ?? "");
    const thinking = frame.indexOf("live thinking above the answer");
    const answer = frame.indexOf("streaming answer text");
    expect(thinking).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(thinking).toBeLessThan(answer);
    releaseText!();
    await done;
    await nap(60);
    ui.unmount();
  });

  // Owner decision (b) on #326: the projection reorders the flushed group
  // above the reply, so the settled transcript keeps the reasoning on top.
  test("settled tail: the model-labelled reasoning block stays above the reply once the turn settles", async () => {
    const stream = async function* () {
      yield { type: "model_call_start", model: "reasoner" };
      yield { type: "reasoning_start" };
      yield { type: "reasoning_delta", text: "settled thinking above the answer" };
      yield { type: "reasoning_end" };
      yield { type: "text_delta", text: "streaming answer text" };
      yield { type: "finish", reason: "stop" };
    };
    const provider: Provider = { name: "reasoner", stream: stream as Provider["stream"] };
    const session = createSession({ provider, memory: { enabled: false } });
    drain(session);
    const ui = render(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="reasoner" width={80} showReasoning />,
    );
    const done = session.send("think");
    await done;
    await nap(80);
    const settledFrame = stripAnsi(ui.lastFrame() ?? "");
    expect(settledFrame.indexOf("settled thinking above the answer")).toBeGreaterThanOrEqual(0);
    expect(settledFrame.indexOf("settled thinking above the answer")).toBeLessThan(settledFrame.indexOf("streaming answer text"));
    ui.unmount();
  });

  // A whole-transcript rebuild (display toggle, mode switch) must keep the
  // historical reasoning above the reply (#242 repaint semantics).
  test("reprojection: whole-transcript rebuilds keep historical reasoning above the reply", async () => {
    const provider = MockProvider.scripted([
      { reasoning: { deltas: ["historical reasoning text"] }, deltas: ["the settled answer"], finish: "stop" },
    ]);
    const session = createSession({ provider, memory: { enabled: false } });
    drain(session);
    const ui = render(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="mock" width={80} showReasoning={false} />,
    );
    await session.send("ask");
    await nap(120);
    // Display toggle repaints the whole transcript in log order.
    ui.rerender(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="mock" width={80} showReasoning />,
    );
    await nap(60);
    // The test renderer keeps the pre-toggle Static output above the
    // repainted transcript (clear-screen escapes don't strip frames), so
    // compare against the LAST copy of the reply in the repainted portion.
    let frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame.indexOf("historical reasoning text")).toBeGreaterThanOrEqual(0);
    expect(frame.indexOf("historical reasoning text")).toBeLessThan(frame.lastIndexOf("the settled answer"));
    // Mode switch rebuilds the transcript too — ordering holds in vibe.
    ui.rerender(
      <Chat session={session} cwd={process.cwd()} mode="vibe" modelLabel="mock" width={80} showReasoning />,
    );
    await nap(60);
    frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame.lastIndexOf("historical reasoning text")).toBeGreaterThanOrEqual(0);
    expect(frame.lastIndexOf("historical reasoning text")).toBeLessThan(frame.lastIndexOf("the settled answer"));
    ui.unmount();
  });
});
