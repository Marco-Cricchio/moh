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

/** #526/#531: terminal scrollback is append-only. Reasoning that arrives
 * before reply prose renders above it naturally; late persisted reasoning
 * stays after already-emitted prose. */
describe("append-only reasoning order (#526/#531)", () => {
  test("settled projection preserves the persisted order", () => {
    const early: AgentEvent[] = [
      { type: "user_message", text: "why?" },
      { type: "reasoning", text: "premise" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "assistant_delta", text: "answer" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, models: ["provider/model"] },
    ];
    const late: AgentEvent[] = [
      { type: "user_message", text: "why?" },
      { type: "assistant_delta", text: "answer" },
      { type: "reasoning", text: "premise" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, models: ["provider/model"] },
    ];
    for (const [events, expected] of [[early, ["thinking", "moh"]], [late, ["moh", "thinking"]]] as const) {
      expect(projectTranscript(events, { showReasoning: true }).filter((b) => b.kind === "thinking" || b.kind === "moh").map((b) => b.kind)).toEqual([...expected]);
    }
  });

  test("a failed call rebuilds to the canonical partial-reply then failed-reasoning order", async () => {
    const stream = async function* () {
      yield { type: "model_call_start", model: "reasoner" };
      yield { type: "reasoning_start" };
      yield { type: "reasoning_delta", text: "reasoning that later fails" };
      yield { type: "reasoning_end" };
      yield { type: "text_delta", text: "partial reply before failure" };
      throw new Error("provider exploded");
    };
    const session = createSession({ provider: { name: "reasoner", stream: stream as Provider["stream"] }, memory: { enabled: false } });
    drain(session);
    const ui = render(<Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="reasoner" width={80} showReasoning />);
    await session.send("fail after text");
    await nap(120);
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame.lastIndexOf("partial reply before failure")).toBeLessThan(frame.lastIndexOf("reasoning that later fails"));
    expect(frame).toContain("failed");
    ui.unmount();
  });

  test("a late reasoning group settles after reply prose", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "stream" },
      { type: "assistant_delta", text: "paragraph.\n\nstill streaming" },
      { type: "reasoning", text: "settled thought" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 0 } },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
    ];
    expect(settledBoundary(events, true)).toBe(4);
    const blocks = projectTranscript(events.slice(0, 4), { showReasoning: true });
    expect(blocks.findIndex((b) => b.kind === "thinking")).toBeGreaterThan(blocks.findIndex((b) => b.kind === "moh"));
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

  test("settled tail keeps late persisted reasoning after the reply", async () => {
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
    expect(settledFrame.indexOf("settled thinking above the answer")).toBeGreaterThan(settledFrame.indexOf("streaming answer text"));
    ui.unmount();
  });

  test("reprojection preserves persisted log order", async () => {
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
    expect(frame.indexOf("historical reasoning text")).toBeGreaterThan(frame.lastIndexOf("the settled answer"));
    // Mode switch rebuilds the transcript too — ordering holds in vibe.
    ui.rerender(
      <Chat session={session} cwd={process.cwd()} mode="vibe" modelLabel="mock" width={80} showReasoning />,
    );
    await nap(60);
    frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame.lastIndexOf("historical reasoning text")).toBeGreaterThanOrEqual(0);
    expect(frame.lastIndexOf("historical reasoning text")).toBeGreaterThan(frame.lastIndexOf("the settled answer"));
    ui.unmount();
  });
});
