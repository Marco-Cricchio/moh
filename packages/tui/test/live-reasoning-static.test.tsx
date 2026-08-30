import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { createSession, type Provider } from "@moh/core";
import { Chat, embedReasoningHeads, nextReasoningHead, spliceReasoningChunks, REASONING_TAIL_LINES, type ReasoningHeadChain } from "../src/Chat";
import type { TranscriptBlock } from "../src/transcript";
import { stripAnsi } from "./helpers";

const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function drain(session: { events: AsyncIterable<unknown> }) {
  void (async () => {
    for await (const _ of session.events) void _;
  })();
}

/** Streams `lines` of reasoning (one delta per line, paced), then holds the
 * text behind a gate the test releases after inspecting mid-turn frames. */
function gatedReasoningProvider(lines: string[], textGate: Promise<void>): Provider {
  const stream = async function* () {
    yield { type: "model_call_start", model: "reasoner" };
    yield { type: "reasoning_start" };
    for (const text of lines) {
      yield { type: "reasoning_delta", text: `${text}\n` };
      await nap(35);
    }
    yield { type: "reasoning_end" };
    await textGate;
    yield { type: "text_delta", text: "final answer" };
    yield { type: "finish", reason: "stop" };
  };
  return { name: "reasoner", stream: stream as Provider["stream"] };
}

describe("nextReasoningHead — incremental head promotion (#329)", () => {
  test("promotes nothing while the block fits the tail budget", () => {
    const chain = nextReasoningHead(null, "live-reasoning", ["a", "b", "c"]);
    expect(chain).toEqual({ key: "live-reasoning", lines: 0, chunks: [], startIndex: 0 });
  });

  test("promotes everything past the tail as an immutable chunk", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const chain = nextReasoningHead(null, "live-reasoning", lines);
    expect(chain!.lines).toBe(lines.length - REASONING_TAIL_LINES);
    expect(chain!.chunks).toHaveLength(1);
    expect(chain!.chunks[0]!.lines).toEqual(lines.slice(0, lines.length - REASONING_TAIL_LINES));
    // idempotent: re-running the same input promotes nothing new
    const again = nextReasoningHead(chain, "live-reasoning", lines);
    expect(again.lines).toBe(chain!.lines);
    expect(again.chunks).toHaveLength(1);
  });

  test("live → log handover keeps the promoted prefix (same text, new key)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const live = nextReasoningHead(null, "live-reasoning", lines);
    const log = nextReasoningHead(live, "7-reasoning", lines);
    expect(log.key).toBe("7-reasoning");
    expect(log.lines).toBe(live.lines);
    expect(log.chunks).toEqual(live.chunks);
  });

  test("a different log key starts a fresh chain, not a handover", () => {
    const chain: ReasoningHeadChain = { key: "3-reasoning", lines: 4, chunks: [], startIndex: 0 };
    const next = nextReasoningHead(chain, "live-reasoning", ["x", "y"]);
    expect(next).toEqual({ key: "live-reasoning", lines: 0, chunks: [], startIndex: 0 });
  });

  test("clamps when the block shrinks (multi-part reset, #240)", () => {
    const chain: ReasoningHeadChain = { key: "live-reasoning", lines: 9, chunks: [], startIndex: 0 };
    const next = nextReasoningHead(chain, "live-reasoning", ["short"]);
    expect(next.lines).toBe(1);
  });
});

describe("settled dedup + chunk splicing (#329)", () => {
  const chunk = (key: string, lines: string[]): TranscriptBlock => ({ key, kind: "thinking", glyph: "⋯", type: "thinking", lines, continuation: true });
  const settled = (key: string, lines: string[]): TranscriptBlock => ({ key, kind: "thinking", glyph: "⋯", type: "thinking", detail: "· model", lines });

  test("embedReasoningHeads dedups a sealed block to its un-promoted remainder", () => {
    const blocks = [settled("0-user_message", ["hi"]), settled("3-reasoning", ["a", "b", "c", "d"])];
    const heads = new Map([["3-reasoning", { chunks: [chunk("3-reasoning-head-0", ["a", "b"])], lines: 2, startIndex: 1 }]]);
    const deduped = embedReasoningHeads(blocks, heads);
    expect(deduped.map((b) => b.key)).toEqual(["0-user_message", "3-reasoning"]);
    expect(deduped[1]!.lines).toEqual(["c", "d"]);
  });

  test("embedReasoningHeads leaves untouched blocks alone", () => {
    const blocks = [settled("0-user_message", ["hi"])];
    expect(embedReasoningHeads(blocks, new Map())).toEqual(blocks);
  });

  test("spliceReasoningChunks inserts each group at its recorded index, ascending", () => {
    const blocks = [settled("0-user_message", ["hi"]), settled("1-reasoning", ["tail"])];
    const spliced = spliceReasoningChunks(blocks, [
      { startIndex: 5, chunks: [chunk("late", ["x"])] },
      { startIndex: 1, chunks: [chunk("early", ["a", "b"])] },
    ]);
    expect(spliced.map((b) => b.key)).toEqual(["0-user_message", "early", "1-reasoning", "late"]);
  });

  test("spliceReasoningChunks with nothing to insert is a stable copy", () => {
    const blocks = [settled("0-user_message", ["hi"])];
    expect(spliceReasoningChunks(blocks, [])).toEqual(blocks);
  });
});

describe("live reasoning Static promotion (#329)", () => {
  test("a long reasoning stream prints every line exactly once after settle", async () => {
    let releaseText: (() => void) | null = null;
    const textGate = new Promise<void>((resolve) => {
      releaseText = resolve;
    });
    const lines = Array.from({ length: 16 }, (_, i) => `thought ${String(i).padStart(2, "0")}`);
    const provider = gatedReasoningProvider(lines, textGate);
    const session = createSession({ provider, memory: { enabled: false } });
    drain(session);
    const ui = render(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="reasoner" width={80} showReasoning />,
    );
    const done = session.send("think");
    // Mid-turn: the promoted head is already in scrollback (Static) and the
    // volatile tail keeps the newest lines — both visible, each once.
    await nap(700);
    const midTurn = stripAnsi(ui.lastFrame() ?? "");
    expect(midTurn).toContain("thought 00");
    expect((midTurn.match(/thought 00/g) ?? []).length).toBe(1);
    releaseText!();
    await done;
    await nap(120);
    const settled = stripAnsi(ui.lastFrame() ?? "");
    for (const line of lines) {
      expect(settled.split(line).length - 1).toBe(1);
    }
    ui.unmount();
  }, 15000);

  test("a width change rebuilds the transcript at the new width, without duplication", async () => {
    const provider = gatedReasoningProvider(["one thought"], Promise.resolve());
    const session = createSession({ provider, memory: { enabled: false } });
    drain(session);
    const element = (width: number) => (
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="reasoner" width={width} showReasoning />
    );
    const ui = render(element(80));
    const done = session.send("think");
    await done;
    await nap(120);
    const before = stripAnsi(ui.lastFrame() ?? "");
    expect(before).toContain("one thought");
    ui.rerender(element(120));
    ui.stdout.emit("resize"); // real terminals re-render on SIGWINCH
    await nap(500); // debounce (150ms) + repaint
    // The rebuild clears screen + scrollback and reprints the transcript at
    // the new width. ink-testing-library runs in debug mode (full-transcript
    // frames, no ANSI erase semantics), so assert on the clear sequence and
    // on the reprint instead of on screen-uniqueness.
    expect(ui.frames.some((frame) => frame.includes("\x1b[3J"))).toBe(true);
    const after = stripAnsi(ui.lastFrame() ?? "");
    expect(after).toContain("one thought");
    ui.unmount();
  }, 15000);
});
