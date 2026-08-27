import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { createSession, type Provider } from "@moh/core";
import { Chat } from "../src/Chat";
import { stripAnsi } from "./helpers";

const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function drain(session: { events: AsyncIterable<unknown> }) {
  void (async () => {
    for await (const _ of session.events) void _;
  })();
}

/** A provider whose reasoning deltas stream, then whose text is held back
 * behind a gate the test releases after inspecting the mid-turn frame. */
function gatedProvider(script: {
  deltas: string[];
  /** Hold before the first text delta (gate released by the test). */
  textGate: Promise<void>;
}): Provider {
  const stream = async function* () {
    yield { type: "model_call_start", model: "reasoner" };
    yield { type: "reasoning_start" };
    for (const text of script.deltas) {
      yield { type: "reasoning_delta", text };
      await nap(60); // still thinking — the TUI must already show the text
    }
    yield { type: "reasoning_end" };
    await script.textGate;
    yield { type: "text_delta", text: "answer" };
    yield { type: "finish", reason: "stop" };
  };
  return { name: "reasoner", stream: stream as Provider["stream"] };
}

/** #253: live reasoning rendering. While the model thinks (turn pending,
 * reasoning deltas streaming, no text yet), the volatile area shows the
 * reasoning text live when display is on — and only a head-only indicator
 * when display is off. */
describe("live reasoning rendering (#253)", () => {
  test("streams reasoning text live in the volatile area while the turn is pending", async () => {
    let releaseText: (() => void) | null = null;
    const textGate = new Promise<void>((resolve) => {
      releaseText = resolve;
    });
    const provider = gatedProvider({ deltas: ["first live thought", " · second"], textGate });
    const session = createSession({ provider, memory: { enabled: false } });
    drain(session);
    const ui = render(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="reasoner" width={80} showReasoning />,
    );
    const done = session.send("think");
    await nap(150);
    const midTurn = stripAnsi(ui.lastFrame() ?? "");
    expect(midTurn).toContain("first live thought");
    expect(midTurn).toContain("second");
    releaseText!();
    await done;
    await nap(60);
    // settled: the completed block is model-labelled; no live duplicate
    const settled = stripAnsi(ui.lastFrame() ?? "");
    expect(settled).toContain("thinking");
    expect((settled.match(/first live thought/g) ?? []).length).toBe(1);
    ui.unmount();
  });

  test("with display off, a pending reasoning turn shows only the static indicator, never the text", async () => {
    let releaseText: (() => void) | null = null;
    const textGate = new Promise<void>((resolve) => {
      releaseText = resolve;
    });
    const provider = gatedProvider({ deltas: ["secret live thought"], textGate });
    const session = createSession({ provider, memory: { enabled: false } });
    drain(session);
    const ui = render(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="reasoner" width={80} showReasoning={false} />,
    );
    const done = session.send("think");
    await nap(100);
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).not.toContain("secret live thought");
    expect(frame).toContain("⋯ thinking");
    releaseText!();
    await done;
    await nap(40);
    ui.unmount();
  });
});
