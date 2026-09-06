import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { createSession, type Provider } from "@moh/core";
import { Chat, embedProseHeads, embedReasoningHeads, isPlainStreamingProse, nextProseHead, nextReasoningHead, promotablePlainPrefix, spliceReasoningChunks, trimProseHead, REASONING_TAIL_LINES, type ReasoningHeadChain } from "../src/Chat";
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
    const chain = nextReasoningHead(null, "live-reasoning", ["a", "b", "c"], 80);
    expect(chain).toEqual({ key: "live-reasoning", chars: 0, source: "a\nb\nc", chunks: [], startIndex: 0 });
  });

  test("promotes everything past the tail as an immutable chunk", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const chain = nextReasoningHead(null, "live-reasoning", lines, 80);
    expect(chain!.chars).toBeGreaterThan(0);
    expect(chain!.chunks).toHaveLength(1);
    expect(chain!.chunks[0]!.lines).toEqual(lines.slice(0, lines.length - REASONING_TAIL_LINES));
    // idempotent: re-running the same input promotes nothing new
    const again = nextReasoningHead(chain, "live-reasoning", lines, 80);
    expect(again.chars).toBe(chain!.chars);
    expect(again.chunks).toHaveLength(1);
  });

  test("wraps an unbroken paragraph into promotable visual rows", () => {
    const chain = nextReasoningHead(null, "live-reasoning", ["one two three four five six seven eight nine ten"], 10, 2);
    expect(chain.chunks[0]!.lines.length).toBeGreaterThan(0);
    expect(chain.chunks[0]!.lines.every((line) => line.length <= 10)).toBe(true);
  });

  test("counts blank lines and hard-splits oversized words", () => {
    const chain = nextReasoningHead(null, "live-reasoning", ["alpha", "", "x".repeat(35), "tail"], 10, 1);
    expect(chain.chunks.flatMap((chunk) => chunk.lines)).toContain("");
    expect(chain.chunks.flatMap((chunk) => chunk.lines).every((line) => line.length <= 10)).toBe(true);
  });

  test("live → log handover keeps the promoted prefix (same text, new key)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const live = nextReasoningHead(null, "live-reasoning", lines, 80);
    const log = nextReasoningHead(live, "7-reasoning", lines, 80);
    expect(log.key).toBe("7-reasoning");
    expect(log.chars).toBe(live.chars);
    expect(log.chunks).toEqual(live.chunks);
  });

  test("a different log key starts a fresh chain, not a handover", () => {
    const chain: ReasoningHeadChain = { key: "3-reasoning", chars: 4, source: "old source", chunks: [], startIndex: 0 };
    const next = nextReasoningHead(chain, "live-reasoning", ["x", "y"], 80);
    expect(next).toEqual({ key: "live-reasoning", chars: 0, source: "x\ny", chunks: [], startIndex: 0 });
  });

  test("holds a capped moving window volatile after one rebuild, then promotes it at reasoning_end", () => {
    const before: ReasoningHeadChain = {
      key: "live-reasoning", chars: 12, source: "old uncapped reasoning", chunks: [{ key: "head", kind: "thinking", glyph: "⋯", type: "thinking", lines: ["old"] }], startIndex: 2,
    };
    const capped = "… reasoning truncated — showing the last 64 KiB (full text stays in the session log) …\nnew tail";
    const rollover = nextReasoningHead(before, "live-reasoning", capped.split("\n"), 20, 5);
    expect(rollover.reset).toBe(true);
    expect(rollover.chunks).toHaveLength(0);
    const moving = nextReasoningHead(rollover, "live-reasoning", `${capped} grows`.split("\n"), 20, 5);
    expect(moving.reset).toBe(true);
    expect(moving.chunks).toHaveLength(0);
    const ended = nextReasoningHead(moving, "live-reasoning", `${capped} grows`.split("\n"), 20, 0);
    expect(ended.chunks.length).toBeGreaterThan(0);
  });

  test("requests a rebuild when a non-capped source stops being append-only", () => {
    const chain: ReasoningHeadChain = { key: "live-reasoning", chars: 9, source: "old value", chunks: [], startIndex: 0 };
    const next = nextReasoningHead(chain, "live-reasoning", ["short"], 80);
    expect(next.reset).toBe(true);
  });
});

describe("assistant prose Static promotion (vision note 33)", () => {
  const prose = (markdown: string): TranscriptBlock => ({
    key: "4-assistant_delta-p0",
    kind: "moh",
    glyph: "◆",
    type: "moh",
    lines: markdown.split("\n"),
    lineKinds: markdown.split("\n").map(() => "body"),
    markdown,
  });

  test("promotes completed visual rows and leaves the newest row live", () => {
    const block = prose("one two three four five six seven eight nine ten eleven twelve");
    const prefix = promotablePlainPrefix(block.markdown!, 12);
    const chain = nextProseHead(null, block, 12);
    expect(prefix.lines.length).toBeGreaterThan(0);
    expect(chain.chars).toBe(prefix.chars);
    expect(chain.chunks[0]!.lines).toEqual(prefix.lines);
    expect(trimProseHead(block, chain.chars)).toMatchObject({ continuation: true });
    expect(trimProseHead(block, chain.chars).markdown).not.toBe("");
    expect(nextProseHead(chain, block, 12)).toEqual(chain);
  });

  test("settled projection removes exactly the source prefix already printed", () => {
    const block = prose("one two three four five six seven eight nine ten eleven twelve");
    const chain = nextProseHead(null, block, 12);
    const deduped = embedProseHeads([block], new Map([[block.key, chain]]));
    expect(deduped[0]!.markdown).toBe(block.markdown!.slice(chain.chars).trimStart());
  });

  test("explicit newlines stay distinct in promoted plain prose", () => {
    expect(promotablePlainPrefix("alpha\nbeta gamma delta epsilon", 12).lines).toEqual(["alpha", "beta gamma", "delta"]);
  });

  test("short and structured Markdown stay volatile", () => {
    expect(nextProseHead(null, prose("still streaming"), 80).chunks).toHaveLength(0);
    expect(Boolean(isPlainStreamingProse("| table |\n| --- |"))).toBe(false);
    expect(Boolean(isPlainStreamingProse("```ts\nconst x = 1"))).toBe(false);
    expect(Boolean(isPlainStreamingProse("# heading"))).toBe(false);
    expect(Boolean(isPlainStreamingProse("heading\n---"))).toBe(false);
    expect(Boolean(isPlainStreamingProse("hard break  \nnext"))).toBe(false);
  });
});

describe("settled dedup + chunk splicing (#329)", () => {
  const chunk = (key: string, lines: string[]): TranscriptBlock => ({ key, kind: "thinking", glyph: "⋯", type: "thinking", lines, continuation: true });
  const settled = (key: string, lines: string[]): TranscriptBlock => ({ key, kind: "thinking", glyph: "⋯", type: "thinking", detail: "· model", lines });

  test("embedReasoningHeads dedups a sealed block to its un-promoted remainder", () => {
    const blocks = [settled("0-user_message", ["hi"]), settled("3-reasoning", ["a", "b", "c", "d"])];
    const heads = new Map([["3-reasoning", { chunks: [chunk("3-reasoning-head-0", ["a", "b"])], chars: 4, source: "a\nb\nc\nd", startIndex: 1 }]]);
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
