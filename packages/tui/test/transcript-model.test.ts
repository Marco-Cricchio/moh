import { describe, expect, test } from "bun:test";
import {
  embedReasoningHeads,
  nextReasoningHead,
  REASONING_TAIL_LINES,
  settledBoundary,
  spliceReasoningChunks,
  transcriptTail,
  trimReasoningHead,
  type ReasoningHeadChain,
} from "../src/Chat";
import type { AgentEvent } from "@moh/core";
import type { TranscriptBlock } from "../src/transcript";

// Level-0 model tests for the transcript model under test where it is pure
// (#1056, T3 of #1052 / ADR-0057). Every test names the PTY baseline
// assertion (research-1052/) whose property it pins at the model level.
const WIDTH = 60; // under the wrap width of the synthetic rows

function thinkBlock(key: string, rows: number, prefix = "REASONING-ROW"): TranscriptBlock {
  return {
    key,
    kind: "thinking",
    glyph: "⋯",
    type: "thinking",
    lines: Array.from({ length: rows }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`),
  };
}

const block = thinkBlock("live-reasoning", 10); // REASONING-ROW-00 .. -09

describe("nextReasoningHead — promotion (#329)", () => {
  test("tailLines=1 promotes all but the newest row and reports the exact chars offset", () => {
    // Baseline: part-a tests 1/4 — a promoted prefix stays in scrollback
    // while the tail keeps streaming.
    expect(REASONING_TAIL_LINES).toBe(1);
    const next = nextReasoningHead(null, "live-reasoning", block.lines, WIDTH);
    // 9 rows stable (00..08), row 09 stays volatile. Each source line is
    // "REASONING-ROW-nn" = 16 chars + the newline it owns (16+1 = 17).
    expect(next.chunks).toHaveLength(1);
    expect(next.chunks[0]!.lines).toEqual(
      Array.from({ length: 9 }, (_, i) => `REASONING-ROW-${String(i).padStart(2, "0")}`),
    );
    expect(next.chars).toBe(9 * 17);
    expect(next.reset).toBeUndefined();
  });

  test("the first chunk carries the thinking head, later ones are continuations", () => {
    const first = nextReasoningHead(null, "live-reasoning", block.lines.slice(0, 5), WIDTH);
    expect(first.chunks[0]!.detail).toBe("…");
    const second = nextReasoningHead(first, "live-reasoning", block.lines, WIDTH);
    expect(second.chunks).toHaveLength(2);
    expect(second.chunks[1]!.continuation).toBe(true);
    expect(second.chunks[1]!.detail).toBeUndefined();
  });

  test("idempotent / monotonic: re-calling with the same input never retrocedes", () => {
    const first = nextReasoningHead(null, "live-reasoning", block.lines, WIDTH);
    const again = nextReasoningHead(first, "live-reasoning", block.lines, WIDTH);
    expect(again.chars).toBe(first.chars);
    expect(again.chunks).toEqual(first.chunks);
    // Growing the source only moves the offset forward.
    const grown = nextReasoningHead(first, "live-reasoning", [...block.lines, "REASONING-ROW-10"], WIDTH);
    expect(grown.chars).toBeGreaterThan(first.chars);
  });

  test("live → settled key change (handover) keeps the promoted prefix", () => {
    // Contract comment: a key change from "live-reasoning" is the handover
    // to the settled model-labelled block — same text, new key. The
    // promoted prefix (chars + chunks) is carried over untouched.
    const live = nextReasoningHead(null, "live-reasoning", block.lines, WIDTH);
    const handed = nextReasoningHead(live, "call-1-thinking", block.lines, WIDTH);
    expect(handed.key).toBe("call-1-thinking");
    expect(handed.chars).toBe(live.chars);
    expect(handed.chunks).toEqual(live.chunks);
  });

  test("any other key change starts a fresh chain, which re-promotes immediately", () => {
    // #1052: distinct calls own distinct chains — but a fresh chain is not
    // frozen at zero: its first call promotes against its own chars=0.
    const handed = nextReasoningHead(null, "call-1-thinking", block.lines, WIDTH);
    const other = nextReasoningHead(handed, "call-2-thinking", block.lines, WIDTH);
    expect(other.key).toBe("call-2-thinking");
    expect(other.chunks).toHaveLength(1);
    expect(other.chars).toBe(handed.chars);
    expect(other.startIndex).toBe(0);
  });

  test("non-append-only source resets the chain", () => {
    const live = nextReasoningHead(null, "live-reasoning", block.lines, WIDTH);
    const rewritten = nextReasoningHead(live, "live-reasoning", ["TOTALLY-DIFFERENT-ROW"], WIDTH);
    expect(rewritten.reset).toBe(true);
    expect(rewritten.chars).toBe(0);
    expect(rewritten.chunks).toEqual([]);
  });

  test("64 KiB cap rollover (windowed source): one reset, then stays volatile", () => {
    // Baseline: part-a test 6 — reasoning past the display cap repaints
    // once, not per frame (#950). reset is asserted only on the frame that
    // discards printed chunks (a chunk-less chain sets reset: false).
    const window = "… reasoning truncated — showing the last 4096 chars";
    const empty = nextReasoningHead(null, "live-reasoning", [window], WIDTH);
    expect(empty.chunks).toEqual([]);
    expect(empty.reset).toBe(false);
    // While windowed, everything stays volatile — the window itself is
    // never promoted (chars stays 0, chunks stay empty).
    const longer = nextReasoningHead(empty, "live-reasoning", [window + " plus more"], WIDTH);
    expect(longer.chunks).toEqual([]);
    expect(longer.chars).toBe(0);
    // A chain that already printed chunks discards them exactly once.
    const live = nextReasoningHead(null, "live-reasoning", ["PLAIN-ROW-A", "PLAIN-ROW-B"], WIDTH);
    expect(live.chunks).toHaveLength(1);
    const rolled = nextReasoningHead(live, "live-reasoning", [window], WIDTH);
    expect(rolled.reset).toBe(true);
    expect(rolled.chunks).toEqual([]);
    const steady = nextReasoningHead(rolled, "live-reasoning", [window], WIDTH);
    expect(steady.reset).toBe(false);
    expect(steady.chunks).toEqual([]);
  });
});

describe("trimReasoningHead — volatile remainder", () => {
  test("slices at a mid-row char offset and strips one leading space", () => {
    const trimmed = trimReasoningHead(block, 10);
    expect(trimmed.lines).toEqual(["ROW-00", ...block.lines.slice(1)]);
    expect(trimmed.continuation).toBe(true);
  });

  test("chars = 0 (or negative) returns the block untouched", () => {
    expect(trimReasoningHead(block, 0)).toBe(block);
    expect(trimReasoningHead(block, -5)).toBe(block);
  });

  test("trimming the whole source empties lines but keeps the block as a continuation", () => {
    const whole = block.lines.join("\n").length;
    const trimmed = trimReasoningHead(block, whole);
    expect(trimmed.lines).toEqual([]);
    expect(trimmed.continuation).toBe(true);
  });
});

describe("embedReasoningHeads + spliceReasoningChunks — printed once (#329)", () => {
  test("the settled projection keeps only the un-promoted remainder", () => {
    // Baseline: part-a tests 9/11/12/13/15 — "prints each block exactly
    // once": the promoted head must not reappear in the settled render.
    const settled = thinkBlock("call-1-thinking", 10);
    const head = nextReasoningHead(null, "call-1-thinking", settled.lines, WIDTH);
    const heads = new Map([
      ["call-1-thinking", { chars: head.chars, chunks: head.chunks, source: head.source, startIndex: head.startIndex }],
    ]);
    const projected = embedReasoningHeads([settled], heads);
    expect(projected[0]!.lines).toEqual(["REASONING-ROW-09"]);
    expect(projected[0]!.continuation).toBe(true);
    // Untracked blocks pass through untouched.
    expect(embedReasoningHeads([settled], new Map())).toEqual([settled]);
  });

  test("splice appends at the current end — already-printed items never move", () => {
    // Contract comment: ink's <Static> counter is forward-only; any
    // insertion below the cursor re-emits printed items (v0.23.1
    // duplicated thinking blocks). Splice must push, ordered by startIndex.
    const settled = [thinkBlock("a", 2), thinkBlock("b", 2), thinkBlock("c", 2)];
    const chunksA = [thinkBlock("a-head-0", 3)];
    const chunksB = [thinkBlock("b-head-0", 2)];
    const spliced = spliceReasoningChunks(settled, [
      { startIndex: 1, chunks: chunksB },
      { startIndex: 0, chunks: chunksA },
    ]);
    // The first three items are byte-identical at their original indices.
    expect(spliced.slice(0, 3)).toEqual(settled);
    expect(spliced.slice(3)).toEqual([...chunksA, ...chunksB]);
    // No-op inserts leave the list alone.
    expect(spliceReasoningChunks(settled, [])).toEqual(settled);
    expect(spliceReasoningChunks(settled, [{ startIndex: 0, chunks: [] }])).toEqual(settled);
  });
});

describe("settledBoundary — incremental promotion boundary (#194)", () => {
  const user: AgentEvent = { type: "user_message", text: "hi" };
  const paragraph: AgentEvent = { type: "assistant_delta", text: "Complete paragraph.\n\n" };
  const call: AgentEvent = { type: "tool_call", callId: "c1", name: "glob", args: { pattern: "*.ts" } } as unknown as AgentEvent;
  const result: AgentEvent = { type: "tool_result", callId: "c1", ok: true, output: "one.ts" };
  const done: AgentEvent = { type: "done" };

  test("not pending: everything is settled", () => {
    const events: AgentEvent[] = [user, paragraph, call, result, done];
    expect(settledBoundary(events, false)).toBe(events.length);
  });

  test("not pending: an unresolved tool_call (composer ! command) stays volatile until its result", () => {
    // ADR-0076: a bang command runs outside a turn — promoting its ◌
    // block printed zero lines Static could never revise, swallowing
    // the output.
    const events: AgentEvent[] = [user, call];
    expect(settledBoundary(events, false)).toBe(1);
    expect(settledBoundary([...events, result], false)).toBe(3);
  });

  test("not pending: an unresolved subagent_spawn stays volatile too", () => {
    const spawn: AgentEvent = { type: "subagent_spawn", callId: "s1", name: "research", preset: "research" } as unknown as AgentEvent;
    const doneSpawn: AgentEvent = { type: "subagent_result", callId: "s1", status: "done", name: "research", usage: { inputTokens: 1, outputTokens: 1 } } as unknown as AgentEvent;
    expect(settledBoundary([user, spawn], false)).toBe(1);
    expect(settledBoundary([user, spawn, doneSpawn], false)).toBe(3);
  });

  test("a closed tool pair passes the boundary past the result (never inside the pair)", () => {
    // Baseline: part-b §9 — the boundary never begins on a tool_result:
    // the whole pair promotes together, so the next print starts after it.
    const events = [user, paragraph, call, result];
    expect(settledBoundary(events, true)).toBe(4);
  });

  test("a pending tool_call keeps the boundary at the tool_call, never mid-pair", () => {
    const events: AgentEvent[] = [user, paragraph, call];
    expect(settledBoundary(events, true)).toBe(2);
  });

  test("holdReplyForReasoning keeps streaming prose volatile mid-run", () => {
    // #326: with the hold, a reply promotes only at the event that seals
    // its call's group — here nothing seals, so only the user_message.
    const events: AgentEvent[] = [user, paragraph, { type: "assistant_delta", text: "still streaming" }];
    expect(settledBoundary(events, true, { holdReplyForReasoning: true })).toBe(1);
    expect(settledBoundary(events, true)).toBe(2);
  });

  test("monotonic while pending: appended events only close prefixes", () => {
    const events: AgentEvent[] = [user, paragraph, call, result, done];
    let previous = 0;
    for (const end of [1, 2, 3, 4, 5]) {
      const boundary = settledBoundary(events.slice(0, end), true);
      expect(boundary).toBeGreaterThanOrEqual(previous);
      previous = boundary;
    }
    expect(previous).toBe(5);
  });
});

describe("transcriptTail — bounded volatile queue (#201/#203)", () => {
  // blockRowsHeight = 3 (head + margins/gap) + wrapped rows at width-3.
  // A 29-char line at bodyWidth 57 wraps to 1 row → a 5-line block = 8 rows.
  function prose(key: string, rows: number): TranscriptBlock {
    return { key, kind: "moh", glyph: "", type: "text", lines: Array(rows).fill("word ".repeat(6).trim()) };
  }

  test("keeps the newest whole blocks that fit the row budget", () => {
    // Baseline: part-a test 8 assert 8 / test 10 — output stays bounded.
    const blocks = [prose("a", 5), prose("b", 5), prose("c", 5)]; // 8 rows each
    const tail = transcriptTail(blocks, WIDTH, 16);
    expect(tail.map((b) => b.key)).toEqual(["b", "c"]);
    // A larger budget keeps all three.
    expect(transcriptTail(blocks, WIDTH, 24).map((b) => b.key)).toEqual(["a", "b", "c"]);
  });

  test("a single oversized block is clipped to its newest rows, never unbounded", () => {
    const giant = prose("giant", 20); // 23 rows > budget 8
    const tail = transcriptTail([prose("old", 5), giant], WIDTH, 8);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.key).toBe("giant");
    // Head + margins cost 3 rows; the body keeps the budget's remainder
    // and the newest line survives the clip.
    expect(3 + tail[0]!.lines.length).toBeLessThanOrEqual(8);
    expect(tail[0]!.lines.at(-1)).toBe(giant.lines.at(-1));
  });
});

describe("reveal-speed invariance (#1052 motivation)", () => {
  // The functions never read a cursor or a clock: identical logical
  // instants (same source prefix) must yield identical promoted rows
  // whatever speed reached them. Chunk *grouping* may differ (chunks are
  // created per frame); the union of promoted rows at the same offset and
  // the final chain state must not. Baseline: part-a test 15 — each
  // thinking block exactly once, independent of streaming cadence.
  const source = Array.from(
    { length: 30 },
    (_, i) => `the reasoning stream advances through step ${String(i).padStart(2, "0")} of the trace`,
  ).join("\n");

  function runAt(speed: number): ReasoningHeadChain[] {
    let chain: ReasoningHeadChain | null = null;
    const frames: ReasoningHeadChain[] = [];
    for (let cursor = speed; cursor <= source.length; cursor += speed) {
      chain = nextReasoningHead(chain, "live-reasoning", [source.slice(0, cursor)], WIDTH);
      frames.push(chain);
    }
    if (source.length % speed !== 0) {
      chain = nextReasoningHead(chain!, "live-reasoning", [source], WIDTH);
      frames.push(chain!);
    }
    return frames;
  }

  const promoted = (frame: ReasoningHeadChain) => frame.chunks.flatMap((c) => c.lines);
  const cursors = (frames: ReasoningHeadChain[]) => frames.map((f) => f.chars);

  test("slow (5 chars/tick), medium (20) and instant (200) reveals promote identically", () => {
    const slow = runAt(5);
    const medium = runAt(20);
    const instant = runAt(200);
    // Monotonic offsets along every run.
    for (const run of [slow, medium, instant]) {
      const cs = cursors(run);
      for (let i = 1; i < cs.length; i++) expect(cs[i]!).toBeGreaterThanOrEqual(cs[i - 1]!);
    }
    // At every instant the instant-run reaches, the slow run has promoted
    // exactly the same rows (prefix equivalence at equal logical time).
    for (const frame of instant) {
      const atSameOffset = slow.filter((f) => f.chars === frame.chars);
      expect(atSameOffset.length).toBeGreaterThan(0);
      expect(promoted(atSameOffset[0]!)).toEqual(promoted(frame));
    }
    // The final state agrees regardless of speed.
    for (const run of [slow, medium, instant]) {
      expect(run.at(-1)!.chars).toBe(instant.at(-1)!.chars);
      expect(promoted(run.at(-1)!)).toEqual(promoted(instant.at(-1)!));
    }
  });

  test("printed once, at the model level: promotions + final tail cover every source row exactly once", () => {
    // Baseline: part-a tests 9/11/12/13/15 — nothing reprints and nothing
    // is lost across promotion and settlement.
    const rows = Array.from({ length: 12 }, (_, i) => `ONCE-ROW-${String(i).padStart(2, "0")}`);
    let chain: ReasoningHeadChain | null = null;
    let promotedRows: string[] = [];
    for (let end = 1; end <= rows.length; end++) {
      chain = nextReasoningHead(chain, "live-reasoning", rows.slice(0, end), WIDTH);
      const fresh = chain.chunks.flatMap((c) => c.lines);
      expect(fresh.slice(0, promotedRows.length)).toEqual(promotedRows); // append-only
      promotedRows = fresh;
    }
    const settledBlock = trimReasoningHead({ ...block, lines: rows }, chain!.chars);
    expect([...promotedRows, ...settledBlock.lines]).toEqual(rows); // exact cover
  });
});
