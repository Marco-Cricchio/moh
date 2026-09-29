import { describe, expect, test } from "bun:test";
import { advanceReveal, DEFAULT_REVEAL_SETTINGS, type RevealSettings } from "../src/reveal";
import { nextReasoningHead, trimReasoningHead, type ReasoningHeadChain } from "../src/Chat";
import type { TranscriptBlock } from "../src/transcript";

const SLOW: RevealSettings = { tickMs: 200, charsPerTick: 5, catchupChars: 100 };
const FAST: RevealSettings = { tickMs: 10, charsPerTick: 60, catchupChars: 1000 };

describe("advanceReveal", () => {
  test("deterministic: same (streamed, ticks) sequence yields the same cursor", () => {
    const sequence: Array<[number, number]> = [
      [1000, 1], [1000, 1], [1050, 2], [1200, 3], [1200, 1], [900, 2],
    ];
    const run = (settings: RevealSettings) => {
      let cursor = 0;
      for (const [streamed, ticks] of sequence) cursor = advanceReveal(cursor, streamed, ticks, settings);
      return cursor;
    };
    expect(run(DEFAULT_REVEAL_SETTINGS)).toBe(run(DEFAULT_REVEAL_SETTINGS));
    expect(run(SLOW)).toBe(run(SLOW));
    expect(run(FAST)).toBe(run(FAST));
  });

  test("paces at base speed for a small deficit", () => {
    // 25 chars behind: boost 1.05 — one tick ≈ 21 chars.
    expect(advanceReveal(975, 1000, 1)).toBeCloseTo(975 + 20 * 1.05, 10);
  });

  test("boost accelerates with the deficit, capped at 5x", () => {
    // 2500 behind: boost = 1 + min(4, 5) = 5 → 100 chars/tick.
    expect(advanceReveal(0, 2500, 1)).toBe(100);
    // 300 behind: boost = 1.6.
    expect(advanceReveal(0, 300, 1)).toBe(32);
  });

  test("never overshoots the stream nor moves backwards", () => {
    expect(advanceReveal(990, 1000, 100)).toBe(1000);
    expect(advanceReveal(500, 400, 3)).toBe(500);
    expect(advanceReveal(500, 400, 0)).toBe(500);
  });

  test("faster settings reveal more per same ticks", () => {
    expect(advanceReveal(0, 1000, 1, FAST)).toBeGreaterThan(advanceReveal(0, 1000, 1, SLOW));
  });
});

describe("promotion ignores reveal pacing (#1054)", () => {
  const width = 40;
  const tailLines = 1;
  const source = Array.from({ length: 24 }, (_, i) => `reasoning line ${i + 1}: the model weighs option ${i + 1} carefully.`).join("\n");
  const block: TranscriptBlock = {
    key: "0-reasoning",
    kind: "thinking",
    glyph: "⋯",
    type: "thinking",
    lines: source.split("\n"),
  } as TranscriptBlock;

  // Simulate a streaming turn: at each step the reveal cursor advances under
  // the given pacing, but promotion always sees the FULL thinking text (the
  // log projection is never cursor-trimmed). Feed the prefix the step makes
  // visible — same content, different reveal speeds — through the promotion
  // pipeline and compare the settled output.
  const runTurn = (settings: RevealSettings) => {
    let chain: ReasoningHeadChain | null = null;
    let cursor = 0;
    let streamed = 0;
    while (streamed < source.length) {
      streamed = Math.min(source.length, streamed + 30); // provider deltas arrive in chunks
      // One tick of reveal per delta chunk, then the cursor catches up.
      while (cursor < streamed) cursor = advanceReveal(cursor, streamed, 1, settings);
      chain = nextReasoningHead(chain, block.key, source.slice(0, cursor).split("\n"), width, tailLines);
    }
    return chain!;
  };

  const promotedRows = (chain: ReasoningHeadChain) => chain.chunks.flatMap((chunk) => chunk.lines);

  test("same contents at different reveal speeds: identical promoted rows and tail", () => {
    const fast = runTurn(FAST);
    const slow = runTurn(SLOW);
    const def = runTurn(DEFAULT_REVEAL_SETTINGS);
    expect(promotedRows(fast)).toEqual(promotedRows(slow));
    expect(promotedRows(fast)).toEqual(promotedRows(def));
    expect(fast.chars).toBe(slow.chars);
    // The volatile tail each run leaves is the same not-yet-promoted remainder.
    expect(trimReasoningHead(block, fast.chars).lines.join("\n"))
      .toBe(trimReasoningHead(block, slow.chars).lines.join("\n"));
  });
});
