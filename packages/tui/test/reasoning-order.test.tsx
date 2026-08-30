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
  test("settled projection: the reasoning block precedes the reply's prose blocks", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "why?" },
      { type: "reasoning", text: "premise one\npremise two" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "assistant_delta", text: "first paragraph.\n\nsecond paragraph." },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, models: ["provider/model"] },
    ];
    const blocks = projectTranscript(events, { showReasoning: true });
    expectReasoningAboveReply(blocks);
    // The reply's paragraphs are separate prose blocks, all after the block.
    expect(blocks.filter((block) => block.kind === "moh" && block.markdown).length).toBe(2);
  });

  test("multi-call fallback chain: each call's reasoning stays above the reply in log order", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "try twice" },
      { type: "reasoning", text: "primary attempt thought" },
      { type: "model_call", model: "primary/model", usage: { inputTokens: 1, outputTokens: 0 }, failed: true },
      { type: "fallback", from: "primary/model", to: "backup/model", reason: "overloaded" },
      { type: "reasoning", text: "backup attempt thought" },
      { type: "model_call", model: "backup/model", usage: { inputTokens: 1, outputTokens: 5 } },
      { type: "assistant_delta", text: "the answer" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 5 }, models: ["backup/model"] },
    ];
    const blocks = projectTranscript(events, { showReasoning: true });
    expectReasoningAboveReply(blocks);
    // Both calls' reasoning blocks project, in log order, above the prose.
    const thinking = blocks.filter((block) => block.kind === "thinking");
    expect(thinking.map((block) => block.lines[0])).toEqual(["primary attempt thought", "backup attempt thought"]);
    expect(blocks.findIndex((block) => block.markdown === "the answer")).toBeGreaterThan(blocks.map((block) => block.kind).lastIndexOf("thinking"));
  });

  test("promotion boundary: the sealed reasoning unit promotes into Static above the reply paragraphs that promote later", () => {
    // Mid-turn: reasoning + model_call sealed, first paragraph closed and
    // promoted, second paragraph still streaming in the volatile area.
    const events: AgentEvent[] = [
      { type: "user_message", text: "stream me an answer" },
      { type: "reasoning", text: "settled thought" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 0 } },
      { type: "assistant_delta", text: "promoted paragraph.\n\n" },
      { type: "assistant_delta", text: "still streaming" },
    ];
    const boundary = settledBoundary(events, true);
    // The sealed unit + closed first paragraph are settled (Static); the
    // open second paragraph stays volatile.
    const settled = projectTranscript(events.slice(0, boundary), { showReasoning: true });
    const volatile = projectTranscript(events.slice(boundary), { showReasoning: true, proseContinuation: true });
    expect(settled.some((block) => block.kind === "thinking")).toBe(true);
    expect(settled.some((block) => block.kind === "moh")).toBe(true);
    expect(volatile.some((block) => block.kind === "moh")).toBe(true);
    // Assembled (Static above volatile), reasoning is above all prose —
    // and inside Static it sealed above the first promoted paragraph.
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

  // KNOWN DEVIATION (reported on #326, 2026-09-04): for a text-only turn the
  // agent loop flushes `reasoning` + `model_call` AFTER the assistant deltas
  // (agent-loop.ts flushes at stream end), so the settled transcript projects
  // the reasoning block BELOW the reply — contradicting the issue's verified
  // claim of `reasoning` → `model_call` → prose log order. Per the issue's
  // instructions this is NOT fixed here; marked failing so it pins the
  // deviation and passes once the owner decides the fix.
  test.failing("settled tail: the model-labelled reasoning block stays above the reply once the turn settles", async () => {
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

  // KNOWN DEVIATION (see the live-tail test above and the #326 comment):
  // once the turn settles, the persisted `reasoning` event lands after the
  // assistant deltas, so a whole-transcript rebuild places the historical
  // reasoning below the reply.
  test.failing("reprojection: whole-transcript rebuilds keep historical reasoning above the reply", async () => {
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
    let frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame.indexOf("historical reasoning text")).toBeGreaterThanOrEqual(0);
    expect(frame.indexOf("historical reasoning text")).toBeLessThan(frame.indexOf("the settled answer"));
    // Mode switch rebuilds the transcript too — ordering holds in vibe.
    ui.rerender(
      <Chat session={session} cwd={process.cwd()} mode="vibe" modelLabel="mock" width={80} showReasoning />,
    );
    await nap(60);
    frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame.indexOf("historical reasoning text")).toBeGreaterThanOrEqual(0);
    expect(frame.indexOf("historical reasoning text")).toBeLessThan(frame.indexOf("the settled answer"));
    ui.unmount();
  });
});
