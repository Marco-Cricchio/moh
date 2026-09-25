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

/** A provider that announces one reasoning part per stream chunk — the shape
 * a real provider produced (measured: 637 `reasoning_start` for one call,
 * most of them empty) — and holds the reply behind a gate so the volatile
 * frame can be sampled mid-turn. */
function chunkedReasoner(chunks: readonly string[]): { provider: Provider; release: () => void; gate: Promise<void> } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = async function* () {
    yield { type: "model_call_start", model: "reasoner" };
    for (const chunk of chunks) {
      yield { type: "reasoning_start" };
      yield { type: "reasoning_delta", text: chunk };
      yield { type: "reasoning_end" };
      await nap(15);
    }
    await gate;
    yield { type: "text_delta", text: "answer" };
    yield { type: "finish", reason: "stop" };
  };
  return { provider: { name: "reasoner", stream: stream as Provider["stream"] }, release, gate };
}

/** The volatile rows the reader sees between the live thinking head and the
 * composer's rule (the block's own rows — the spacer row before the rule and
 * the rule itself are layout, not the block). */
function liveThinkingRows(frame: string): string[] {
  const lines = stripAnsi(frame).split("\n");
  const head = lines.findIndex((line) => line.includes("thinking"));
  if (head === -1) return [];
  const rule = lines.findIndex((line, index) => index > head && line.includes("───"));
  return lines.slice(head + 1, rule === -1 ? lines.length : rule - 1);
}

describe("live reasoning keeps the log's shape (#993)", () => {
  test("parts announced per chunk never promote blank rows into the transcript", async () => {
    // Empty parts only. The old buffer added a paragraph break per announced
    // part, so the reasoning head chain promoted a blank row per frame into
    // the append-only transcript (`ui.frames` carries it: the test harness
    // renders with Ink's debug writer, which reprints the static output).
    const { provider, release } = chunkedReasoner(["", "", "", "", "", ""]);
    const session = createSession({ provider, memory: { enabled: false } });
    drain(session);
    const ui = render(<Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="reasoner" width={80} showReasoning />);
    const done = session.send("think");
    await nap(800);
    const rows = stripAnsi(ui.frames.at(-1) ?? "").split("\n");
    // The transcript's own layout uses single blank rows between blocks; a
    // run is empty space a provider never wrote.
    let run = 0;
    let longest = 0;
    for (const row of rows) {
      run = row.trim() === "" ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThanOrEqual(1);
    release();
    await done;
    ui.unmount();
  });

  test("chunked text renders once, in order, with exactly the log's blank line", async () => {
    // No trailing newline inside a chunk, so the blank rows between two kept
    // parts are exactly the one separator the log has: one separator per
    // announced part (the old behavior) leaves three.
    const { provider, release } = chunkedReasoner(["alpha", "", "beta"]);
    const session = createSession({ provider, memory: { enabled: false } });
    drain(session);
    const ui = render(<Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="reasoner" width={100} showReasoning />);
    const done = session.send("think");
    await nap(300);
    const liveRows = stripAnsi(ui.lastFrame() ?? "").split("\n").map((row) => row.trim());
    expect(liveRows).toContain("alpha");
    expect(liveRows).toContain("beta");
    expect(liveRows.indexOf("alpha")).toBeLessThan(liveRows.indexOf("beta"));
    expect(liveRows.slice(liveRows.indexOf("alpha") + 1, liveRows.indexOf("beta"))).toEqual([""]);
    release();
    await done;
    await nap(120);
    const settledRows = stripAnsi(ui.lastFrame() ?? "").split("\n").map((row) => row.trim());
    expect(settledRows.filter((row) => row === "alpha")).toHaveLength(1);
    expect(settledRows.filter((row) => row === "beta")).toHaveLength(1);
    expect(settledRows.slice(settledRows.indexOf("alpha") + 1, settledRows.indexOf("beta"))).toEqual([""]);
    ui.unmount();
  });
});
