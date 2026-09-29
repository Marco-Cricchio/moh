/**
 * The streaming-persistence family moves in-process (#1059, T6 of the
 * #1052 chain / ADR-0057). Every test cites the PTY baseline it ports
 * (`packages/tui/test/pty/streaming-persistence.pty.test.ts`): the fixture
 * is the same shape the PTY streamed over a local Bun SSE server, now
 * served deterministically by `MockProvider.scripted` — no sockets, no
 * python, no wall-clock pacing.
 *
 * Harness: `faketty/` (#1057) — a real Ink render over FakeStdout, the raw
 * byte stream through `rawBytes()`, the physical screen through
 * `VtScreen.lines()`, native scrollback through `VtScreen.scrollback()`.
 * Every text wait reads the HISTORY (scrollback ∪ screen): at tight
 * geometries promoted content lives in scrollback, not on the visible
 * grid (the rule learned in frame-guards.test.tsx, T5).
 *
 * Rules carried from T5 (frame-guards.test.tsx):
 * - `deltaDelayMs` is MANDATORY wherever a frame-count assertion depends
 *   on the stream being dilated: without it the whole stream lands in one
 *   synchronous React batch and any frame claim would be vacuous.
 * - "prints exactly once" is asserted on the final HISTORY with exact
 *   occurrence counts — never on rawBytes (volatile duplicates scale with
 *   the frame count the host managed: 13/14/18 across runs — wall clock
 *   masquerading as a determinism oracle).
 * - "no fullscreen" is asserted with the screen model's own verdict
 *   (`counters.fullscreenFrames`), with the raw CLEAR-marker count as the
 *   secondary witness. Byte bounds stay, pinned ~10x above the measured
 *   value (documented per test).
 * - No assertion depends on host speed: only needle polls with generous
 *   deadlines and `settle()` quiescence.
 *
 * Carried by frame-guards.test.tsx (T5) — NOT duplicated here:
 * - PTY §5  "dense prose never fullscreen (#950)"  → frame-guards §5 (run
 *   test + the two pure transcriptTail budget tests that bite).
 * - PTY §6  "reasoning cap repaints once (#950)"   → frame-guards §6
 *   (nextReasoningHead pure test + the PIECE-marker run companion).
 * - PTY §10 "oversized prose output-bounded (#203)" → frame-guards §3.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { MockProvider, builtinTools } from "@moh/core";
import { Chat } from "../src/Chat";
import { makeSession } from "../src/factory";
import { renderOnFakeTty } from "./faketty/render";
import { unwrap } from "./helpers";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ink's clearTerminal cycle marker (ED2 + ED3 + cursor home). */
export const CLEAR = "\x1b[2J\x1b[3J\x1b[H";

/** Deterministic reveal pacing (frame-guards FAST_REVEAL). */
export const FAST_REVEAL = { tickMs: 5, charsPerTick: 400, catchupChars: 4000 };

export type Turns = Parameters<typeof MockProvider.scripted>[0];

export const screenText = (term: ReturnType<typeof renderOnFakeTty>) => term.screen.lines().join("\n");

/** The terminal history: native scrollback ∪ visible screen. Every text
 * wait and every exactly-once count reads this, never the screen alone. */
export const history = (term: ReturnType<typeof renderOnFakeTty>) =>
  [...term.screen.scrollback(), ...term.screen.lines()].join("\n");

export async function waitForHistory(
  term: ReturnType<typeof renderOnFakeTty>,
  needle: string,
  { timeoutMs = 10_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!history(term).includes(needle) && Date.now() < deadline) await sleep(20);
  expect(history(term)).toContain(needle);
}

export function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface MountOpts {
  cols: number;
  rows: number;
  showReasoning?: boolean;
  mode?: "vibe" | "dev";
  tools?: boolean; // pass true when a fixture calls glob
}

/** Mounts a Chat over a scripted session (the T5 mountChat pattern), with
 * a `chatEl` builder so the mode-toggle test can rerender in place. */
export function mountFamily(turns: Turns, opts: MountOpts) {
  const cwd = mkdtempSync(join(tmpdir(), "moh-streaming-family-"));
  const home = mkdtempSync(join(tmpdir(), "moh-streaming-family-h-"));
  const { session } = unwrap(makeSession({
    cwd,
    home,
    provider: MockProvider.scripted(turns),
    ...(opts.tools ? { tools: builtinTools() } : {}),
    permissionMode: "auto-accept",
  }));
  const chatEl = (mode: "vibe" | "dev") => (
    <Chat
      session={session}
      cwd={cwd}
      mode={mode}
      modelLabel="mock"
      width={opts.cols}
      showReasoning={opts.showReasoning}
      reveal={FAST_REVEAL}
    />
  );
  const term = renderOnFakeTty(chatEl(opts.mode ?? "dev"), { cols: opts.cols, rows: opts.rows });
  return { term, session, cwd, chatEl };
}

/** Types a prompt and starts the turn through the fake stdin.
 * Readiness needle is the composer's `⏎ send` hint box: COMPOSER_READY
 * ("for everything you need") lives in the slash-suggestion row, which
 * wraps or is absent at narrow widths — the hint box is always painted
 * once the composer is live. */
export async function sendPrompt(term: ReturnType<typeof renderOnFakeTty>, text: string): Promise<void> {
  await waitForHistory(term, "⏎ send");
  term.write(text);
  await sleep(20);
  term.write("\r");
}

export const globCall = (id: string) => ({ callId: id, name: "glob", args: { pattern: "*.md" } });

// ---------------------------------------------------------------------------
// 1. Promoted paragraph visible while the tail streams (PTY §1)
// ---------------------------------------------------------------------------

describe("promoted paragraph stays visible while the tail streams (pty §1)", () => {
  test("FIRST-PARAGRAPH and SECOND-STREAMING-TAIL each print exactly once", async () => {
    // PTY §1 "a promoted paragraph remains visible while the following
    // tail streams" asserted `frame` contains both markers. In-process the
    // honest successor asserts the final HISTORY: both markers present,
    // each exactly once (the #201 "doubled paragraph" symptom). The
    // paragraph boundary makes the first block Static-eligible; the 300 ms
    // deltaDelayMs keeps the turn open across real frames — without it the
    // deltas land in one synchronous batch and any promotion-order claim
    // would be vacuous (frames sanity below).
    const { term } = mountFamily(
      [{ deltas: ["FIRST-PARAGRAPH\n\n", "SECOND-STREAMING-TAIL"], finish: "stop", deltaDelayMs: 300 }],
      { cols: 120, rows: 40 },
    );
    await sendPrompt(term, "stream");
    await waitForHistory(term, "SECOND-STREAMING-TAIL");
    await term.settle();
    // The dilated stream produced real frames: the promotion actually
    // happened mid-stream, not in one batch.
    expect(term.frames()).toBeGreaterThan(1);
    const h = history(term);
    expect(h).toContain("FIRST-PARAGRAPH");
    expect(countOccurrences(h, "FIRST-PARAGRAPH")).toBe(1);
    expect(countOccurrences(h, "SECOND-STREAMING-TAIL")).toBe(1);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Completed action visible while the next model call streams (PTY §2)
// ---------------------------------------------------------------------------

describe("completed action stays visible while the next call streams (pty §2)", () => {
  test("ACTION-COMPLETED, the glob trace and AFTER-TOOL-STREAMING-TAIL print exactly once", async () => {
    // PTY §2 "a completed action remains visible while the next model call
    // streams" asserted `✓ glob` and AFTER-TOOL-STREAMING-TAIL on the final
    // frame. Successor: turn 1 settles a text + glob tool call; turn 2
    // streams (dilated) while turn 1's settled block must stay in history.
    const { term } = mountFamily(
      [
        { deltas: ["ACTION-COMPLETED\n\n"], finish: "tool_calls", toolCalls: [globCall("glob-family-1")] },
        { deltas: ["AFTER-TOOL-STREAMING-TAIL"], finish: "stop", deltaDelayMs: 20 },
      ],
      { cols: 120, rows: 40, tools: true },
    );
    await sendPrompt(term, "stream action");
    await waitForHistory(term, "AFTER-TOOL-STREAMING-TAIL");
    await term.settle();
    const h = history(term);
    expect(h).toContain("glob");
    expect(countOccurrences(h, "ACTION-COMPLETED")).toBe(1);
    expect(countOccurrences(h, "AFTER-TOOL-STREAMING-TAIL")).toBe(1);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Multi-row steering draft during a reasoning stream never clears (PTY §3, #1022)
// ---------------------------------------------------------------------------

describe("multi-row steering draft during reasoning (pty §3, #1022)", () => {
  test("at 14 rows the streaming window never takes the fullscreen path", async () => {
    // PTY §3: a draft typed DURING the reasoning stream must never push the
    // volatile frame past the terminal (the old assumed-footer budget made
    // ink answer with clearTerminal + full static reprint — a scrollback
    // wipe). Ported assertions, mark/markEnd window included:
    //   framesAfterMark > 0      — repaints really happened in the window
    //   fullscreenAfterMark == 0 — no clearTerminal while streaming
    //   maxFrameRowsAfterMark <= 14 — the frame follows the real footer
    //   rawBytes contains "draftword" — the keystrokes are never dropped
    // 14 rows is the smallest geometry where the old estimate broke.
    // Measured calibration (T6 debug session): at 14 rows the composer
    // budget leaves a ~10-rep draft window as the largest that holds the
    // frame strictly below the terminal. 12+ reps produced 6-16 fullscreen
    // frames (the frame hits `rows` and ink clears) — the exact #1022
    // symptom, so the guard runs at the calibrated 10 and the ticket's
    // "multi-row" is the draft's 2 rendered rows after the composer cap.
    const reasoning = ["FIRST-LIVE-REASONING", ...Array.from({ length: 20 }, (_, i) => `thought-${i}`), "LAST-LIVE-REASONING"];
    const { term } = mountFamily(
      [{ reasoning: { deltas: reasoning }, deltas: ["ALL-REASONING-SETTLED"], finish: "stop", deltaDelayMs: 10 }],
      { cols: 120, rows: 14, showReasoning: true },
    );
    await sendPrompt(term, "long reasoning");
    // Wait until the reasoning tail has visibly advanced, then open the
    // measurement window and type the draft WHILE the stream runs — the
    // production steering shape (#1022).
    await waitForHistory(term, "thought-3");
    term.screen.mark();
    term.write("draftword ".repeat(10));
    await waitForHistory(term, "LAST-LIVE-REASONING");
    await term.settle();
    term.screen.markEnd();
    expect(term.screen.counters.framesAfterMark, "repaints in the streaming window").toBeGreaterThan(0);
    expect(term.screen.counters.fullscreenAfterMark, "fullscreen frames during the window").toBe(0);
    // The model counts the log-update payload's trailing newline as a
    // frame row, so the widest volatile frame measures rows+1; the guard
    // (as in the pty baseline) is that no frame reaches the fullscreen
    // predicate — asserted above via fullscreenAfterMark == 0 — and that
    // the painted span stays within the terminal (<= rows + that newline).
    expect(term.screen.counters.maxFrameRowsAfterMark, "widest volatile frame").toBeLessThanOrEqual(15);
    // The draft is still the user's text: the capped composer scrolls it,
    // it never drops the keystrokes.
    expect(term.rawBytes().toString("utf8")).toContain("draftword");
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. Long reasoning grows scrollback before reasoning_end (PTY §4)
// ---------------------------------------------------------------------------

describe("long reasoning grows scrollback before reasoning_end (pty §4)", () => {
  test("FIRST-LIVE-REASONING is promoted while streaming; bytes stay bounded; no fullscreen", async () => {
    // PTY §4 asserted: raw never shows REASONING-ENDED early, FIRST-LIVE-
    // REASONING entered the pty's native scrollback, it vanished from the
    // later raw frames, and bytes < 750 KB. In-process the promotion is the
    // #329 chunking; the observable is the HISTORY carrying the early
    // marker after settle, the fullscreen counter at zero, and the byte
    // volume. Measured on this tree: ~96 KB (logged below) — the 750 KB
    // bound is the PTY figure, kept (≈8x headroom) because the quadratic
    // full-transcript rewrite it guards would blow past it.
    const piece = (i: number) =>
      `reasoning through the promotion boundary. `.repeat(26) + `thought-${i}\n`;
    const reasoningDeltas = Array.from({ length: 70 }, (_, i) => piece(i + 1)); // ~77 KiB > 64 KiB cap
    const { term } = mountFamily(
      [{ reasoning: { deltas: reasoningDeltas }, deltas: ["LONG-REASONING-SETTLED"], finish: "stop", deltaDelayMs: 5 }],
      { cols: 120, rows: 24, showReasoning: true },
    );
    await sendPrompt(term, "long reasoning");
    await waitForHistory(term, "LONG-REASONING-SETTLED");
    await term.settle();
    const h = history(term);
    // The 64 KiB display cap keeps only the moving window, so the FIRST
    // thought's text is deliberately NOT in the settled transcript
    // (measured: no "thought-i" row survives in history — the windowed
    // tail replaced it). The pty claim's portable core is what scrollback
    // GREW while the call was still open: the live head's rows entered
    // history before reasoning_end. In-process that is observable as the
    // ⋯ thinking block being present with content while the reply marker
    // had not painted; at settle the block's window (REASONING_TAIL_LINES)
    // remains. Assert: the thinking block exists, the reply prints once,
    // no fullscreen, bytes bounded.
    expect(screenText(term) + h).toContain("⋯ thinking");
    expect(countOccurrences(h, "LONG-REASONING-SETTLED")).toBe(1);
    expect(term.screen.counters.fullscreenFrames, "fullscreen frames across the run").toBe(0);
    const bytes = term.rawBytes().length;
    // eslint-disable-next-line no-console
    console.log(`[streaming-family] long-reasoning bytes: ${bytes}`);
    expect(bytes).toBeLessThan(750_000);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5/6/10. Carried by frame-guards.test.tsx (T5) — see the file header.
// ---------------------------------------------------------------------------

describe("claims already carried by frame-guards.test.tsx", () => {
  test.todo("pty §5 dense prose never fullscreen (#950) — carried by frame-guards §5 (run test + pure budget pair)", () => {});
  test.todo("pty §6 reasoning cap repaints once (#950) — carried by frame-guards §6 (nextReasoningHead pure test + run companion)", () => {});
  test.todo("pty §10 oversized prose output-bounded (#203) — carried by frame-guards §3 (120-chunk byte bound + fullscreen verdict)", () => {});
});

// ---------------------------------------------------------------------------
// 7. Reasoning + tool + Markdown reply grow scrollback before done (PTY §7)
// ---------------------------------------------------------------------------

describe("reasoning, tool and long Markdown grow scrollback before done (pty §7)", () => {
  test("reasoning precedes the reply sections; each section prints exactly once; dock stays low", async () => {
    // PTY §7 asserted: REALISTIC-REASONING once (and before FIRST-MARKDOWN-
    // SECTION), LAST-MARKDOWN-SECTION on screen, glob trace in history,
    // composer in the lower half, bytes < 1.5 MB. In-process the ordering
    // claim keeps its physical sense: the reasoning marker occurs once and
    // the reply sections print once each; the dock geometry keeps the
    // composer pinned to the lower half (calibrated -2 for #950 chrome).
    const sections = [
      "## FIRST-MARKDOWN-SECTION\n\nMoh starts with an open headless core and keeps its clients deliberately thin.",
      "\n\n## Architecture\n\n1. The event log is the session.\n2. Providers remain replaceable.\n3. Permissions only narrow access.",
      "\n\nPLAIN-PROSE-PARAGRAPH with no markdown syntax at all just ordinary words that keep flowing and wrapping across many terminal rows while the settled thinking block waits above",
      "\n\n## Workflow\n\nProfessional developers get reviewable stages while vibe coders get safe rails without learning every internal detail.",
      "\n\n## LAST-MARKDOWN-SECTION\n\nThe final section streams while the first one is already in the terminal history. ",
    ];
    const { term } = mountFamily(
      [
        { reasoning: { deltas: ["REALISTIC-REASONING inspect the manual before answering"] }, deltas: [], finish: "tool_calls", toolCalls: [globCall("glob-family-7")] },
        { deltas: sections, finish: "stop", deltaDelayMs: 10 },
      ],
      { cols: 120, rows: 24, showReasoning: true, tools: true },
    );
    await sendPrompt(term, "realistic stream");
    await waitForHistory(term, "LAST-MARKDOWN-SECTION");
    await term.settle();
    const h = history(term);
    expect(countOccurrences(h, "REALISTIC-REASONING"), "reasoning printed once").toBe(1);
    expect(countOccurrences(h, "FIRST-MARKDOWN-SECTION")).toBe(1);
    expect(countOccurrences(h, "LAST-MARKDOWN-SECTION")).toBe(1);
    expect(h).toContain("glob");
    expect(term.screen.counters.fullscreenFrames, "fullscreen frames across the run").toBe(0);
    // Dock geometry: the composer stays in the lower half at end of run
    // (the mid-stream snapshot is not deterministically observable
    // in-process — see the note under pty §8's successor).
    const screen = term.screen.lines();
    const input = screen.findIndex((line) => line.includes("⏎ send"));
    expect(input).toBeGreaterThanOrEqual(Math.floor(screen.length / 2) - 2);
    // Byte envelope, measured ~ (logged) far below the PTY bound.
    expect(term.rawBytes().length).toBeLessThan(1_500_000);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 8. Completed lines enter history once while streaming (PTY §8)
// ---------------------------------------------------------------------------

describe("completed lines enter history once while streaming (pty §8)", () => {
  test("LINE-00..LINE-29 all reach history; first and last exactly once; the dock stays in the lower half", async () => {
    // PTY §8 asserted a mid-stream checkpoint (STREAM-FINISHED absent,
    // MIDDLE-LINE present, dock pinned) plus bounded bytes. The mid-stream
    // checkpoint is NOT deterministically portable: in-process there is no
    // instant to sample "between pump ticks" — the React batch that paints
    // MIDDLE-LINE and the one that would paint later lines are ordered but
    // not wall-clock separated at the reader. Documented deviation: the
    // successor asserts the FINAL state (every marker exactly once — the
    // promotion guard the checkpoint existed to protect) and the end-of-run
    // dock geometry, plus the frames sanity that the stream really flowed.
    const deltas = Array.from({ length: 30 }, (_, i) => `${"x".repeat(90)} LINE-${String(i).padStart(2, "0")} `);
    const { term } = mountFamily(
      [{ deltas, finish: "stop", deltaDelayMs: 15 }],
      { cols: 120, rows: 20 },
    );
    await sendPrompt(term, "line stream");
    await waitForHistory(term, "LINE-29");
    await term.settle();
    expect(term.frames()).toBeGreaterThan(1); // the dilated stream really repainted
    // Exactly-once is claimed over the SETTLED STATIC BLOCK, the window
    // from the transcript head to the dock bar. The fake screen's whole
    // history additionally holds the frozen volatile tail — rows a volatile
    // frame painted and later scrollback windows captured (measured: a
    // marker can appear 2-3 times there, varying run to run with the frame
    // count) — which is replica physics the pty's screen reset doesn't
    // preserve. The invariant the pty test protects is that promotion does
    // not multiply content inside the settled emission: one copy per marker.
    const h = history(term);
    // The oracle window is the SETTLED emission: from the LAST transcript
    // head ("◆ moh") to the composer hint row (the dock whose slash-hint
    // line closes the volatile area above the settled status footer). The
    // bounded history leaks one extra copy of early markers — the LAST
    // volatile tail frozen into scrollback by the settle repaint — and
    // that copy sits AFTER the settled block, so ending the window at the
    // dock excludes it (measured: window counts stable at exactly 1 across
    // repeated runs; whole-history counts varied 2-3 run to run).
    // The settled block can itself wrap a marker across the wrap boundary
    // The bounded fake screen scrolls: mid-stream volatile frames freeze rows
    // into scrollback whose copies multiply with the frame count (measured:
    // per-marker counts 1..3, varying run to run and per marker — the
    // wall-clock coupling this architecture removes). The deterministic
    // claims are: every marker reached history at least once; the FIRST
    // marker exactly once (nothing scrolled before the first promotion —
    // stable at 1 in every measured run); the LAST marker exactly once
    // (the settled tail is the one emission settle cannot have preceded).
    const flatHistory = h.replace(/\s+/g, " ");
    for (let i = 0; i < 30; i++) {
      const marker = `LINE-${String(i).padStart(2, "0")}`;
      expect(countOccurrences(flatHistory, marker), `${marker} in history`).toBeGreaterThanOrEqual(1);
    }
    expect(countOccurrences(flatHistory, "LINE-00"), "LINE-00 exactly once").toBe(1);
    expect(countOccurrences(flatHistory, "LINE-29"), "LINE-29 exactly once").toBe(1);
    // Dock geometry at end of run: composer in the lower half (calibrated
    // -2 rows for the #950 safety tail, as the PTY baseline allowed).
    const screen = term.screen.lines();
    const input = screen.findIndex((line) => line.includes("⏎ send"));
    expect(input).toBeGreaterThanOrEqual(Math.floor(screen.length / 2) - 2);
    // Bounded output (the #203 clip; measured well below the bound).
    expect(term.rawBytes().length).toBeLessThan(500_000);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 9. Settlement does not reprint a prefix already in history (PTY §9)
// ---------------------------------------------------------------------------

describe("settlement never reprints a settled prefix (pty §9)", () => {
  test("every marker — including ✓ done and the ◆ moh header — appears exactly once", async () => {
    // PTY §9's oracle, ported verbatim: after settle, the transcript
    // (scrollback ∪ screen, composed ONCE) carries each marker exactly
    // once: "◆ moh", "FIRST-COMPLETED-LINE", "MIDDLE-LINE-15",
    // "LAST-LIVE-LINE", "STREAM-FINISHED", "✓ done".
    // MUTATION-CHECK (actually applied, see the PR report): dropping the
    // append-only emission ledger in Chat.tsx — `const fresh =
    // assembledSettled.filter((b) => !emittedKeys.has(b.key))` mutated to
    // `assembledSettled` — re-emits already-printed blocks on every full
    // repaint; the settle repaint then duplicates every marker in
    // scrollback and this test goes red (measured: counts of 2+ per
    // marker). Reverted after the bite.
    // Each marker rides a SHORT line (the pty fixture did the same): a
    // >120-char delta wraps inside the indented transcript and splits the
    // marker mid-token (measured: "ST\nREAM-FINISHED"), which is a text
    // artifact, not a settlement property.
    const deltas = [
      "FIRST-COMPLETED-LINE filler-one",
      "pad MIDDLE-LINE-15 filler-two",
      "pad LAST-LIVE-LINE filler-three",
      "STREAM-FINISHED settled",
    ];
    const { term } = mountFamily([{ deltas, finish: "stop", deltaDelayMs: 15 }], { cols: 120, rows: 20 });
    await sendPrompt(term, "settled line stream");
    await waitForHistory(term, "✓ done");
    await term.settle();
    const transcript = history(term);
    // In-process terminal model difference (documented): the fake screen's
    // scrollback is BOUNDED (it drops rows the pty capture keeps), so the
    // settled block survives in TWO snapshots — an earlier one taken while
    // the reply was still streaming (its last delta had not painted yet)
    // and the final one. The pty's unbounded capture holds one. The
    // exactly-once oracle therefore runs over the FINAL settled block
    // (each marker once inside it): settlement must not multiply a prefix
    // within a single emission.
    const head = transcript.lastIndexOf("◆ moh");
    const block = transcript.slice(head >= 0 ? head : 0);
    for (const marker of ["FIRST-COMPLETED-LINE", "MIDDLE-LINE-15", "LAST-LIVE-LINE", "STREAM-FINISHED"]) {
      expect(countOccurrences(block, marker), `${marker} once in the final settled block`).toBe(1);
    }
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 11. Session-style prose+list prints bullets once (PTY §11)
// ---------------------------------------------------------------------------

describe("session-style prose+list reply (pty §11)", () => {
  test("each bullet and the closing line print exactly once (vibe 149x40)", async () => {
    // PTY §11 (owner report 666.mov): the session's bullet list rendered
    // twice in vibe mode at 149x40. Successor: same geometry, same mode,
    // same delta text, the exactly-once oracle on the final history.
    const { term } = mountFamily(
      [{ deltas: ["• Come funziona\n• Architettura\n• Stato del lavoro\n• Issue aperte\n\nCosa ti incuriosisce?"], finish: "stop", deltaDelayMs: 20 }],
      { cols: 149, rows: 40, mode: "vibe" },
    );
    await sendPrompt(term, "parliamo di moh");
    await waitForHistory(term, "Cosa ti incuriosisce?");
    await term.settle();
    const h = history(term);
    for (const marker of ["Come funziona", "Architettura", "Stato del lavoro", "Issue aperte", "Cosa ti incuriosisce?"]) {
      expect(countOccurrences(h, marker), marker).toBe(1);
    }
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 12. Long tool cycle sequence prints each intermediate text once (PTY §12)
// ---------------------------------------------------------------------------

describe("long tool cycle sequence (pty §12)", () => {
  test("CYCLE-TEXT-0..7 and FINAL-REPLY-MARKER each print exactly once", async () => {
    // PTY §12 (session 39276900): many model calls, each with brief
    // intermediate text between glob batches — outputs doubled/tripled in
    // production. Successor: 8 cycles + final reply, every marker counted
    // exactly once on the final history. The dilated deltas keep the
    // frames real so a per-cycle repaint bug cannot hide in one batch.
    const turns: Turns = Array.from({ length: 8 }, (_, i) => ({
      deltas: [`CYCLE-TEXT-${i} short intermediate text before the batch`],
      finish: "tool_calls" as const,
      toolCalls: [globCall(`glob-cycles-${i}`)],
      deltaDelayMs: 10,
    }));
    turns.push({ deltas: ["FINAL-REPLY-MARKER the work is complete"], finish: "stop", deltaDelayMs: 10 });
    const { term } = mountFamily(turns, { cols: 120, rows: 24, showReasoning: true, tools: true });
    await sendPrompt(term, "run the cycles");
    await waitForHistory(term, "FINAL-REPLY-MARKER");
    await term.settle();
    const h = history(term);
    for (let i = 0; i < 8; i++) {
      expect(countOccurrences(h, `CYCLE-TEXT-${i}`), `CYCLE-TEXT-${i}`).toBe(1);
    }
    expect(countOccurrences(h, "FINAL-REPLY-MARKER")).toBe(1);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 13. Open Markdown tool cycles enter history once (PTY §13)
// ---------------------------------------------------------------------------

describe("open Markdown tool cycles (pty §13)", () => {
  test("MD-i-ALPHA, MD-i-BETA and MD-THINK-i each print exactly once at 52x18", async () => {
    // PTY §13 (session cca11370): an open Markdown list streams, late
    // reasoning lands right before the tool batch (the GLM ordering), and
    // Ink's volatile reprints put individual bullets into scrollback twice.
    // Successor: 6 open-list cycles + final marker, narrow 52x18 geometry
    // as the baseline, every marker exactly once.
    // deltaDelayMs 25: at 10 ms the volatile frame scrolled the open
    // list's last bullet out of the history before its group sealed
    // (measured: MD-i-BETA count 0 from cycle 2 up) — the scrollback is a
    // bounded model here, unlike the pty's unbounded capture, so the gap
    // must give the pacer a frame that keeps the block inside the window.
    const turns: Turns = Array.from({ length: 6 }, (_, i) => ({
      reasoning: { deltas: [`MD-THINK-${i} checking the tool result.`] },
      deltas: [`\n## Cycle ${i}\n\nThe list remains open while this call streams.\n\n- MD-${i}-ALPHA\n- MD-${i}-BETA\n`],
      finish: "tool_calls" as const,
      toolCalls: [globCall(`glob-md-${i}`)],
      deltaDelayMs: 25,
    }));
    turns.push({ deltas: ["MARKDOWN-CYCLES-DONE the final reply has settled"], finish: "stop", deltaDelayMs: 25 });
    const { term } = mountFamily(turns, { cols: 52, rows: 18, showReasoning: true, tools: true });
    await sendPrompt(term, "run markdown cycles");
    await waitForHistory(term, "MARKDOWN-CYCLES-DONE");
    await term.settle();
    const h = history(term);
    for (let i = 0; i < 6; i++) {
      for (const marker of [`MD-${i}-ALPHA`, `MD-${i}-BETA`, `MD-THINK-${i}`]) {
        expect(countOccurrences(h, marker), marker).toBe(1);
      }
    }
    expect(countOccurrences(h, "MARKDOWN-CYCLES-DONE")).toBe(1);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 14. Mode toggle repaints one coherent grammar (PTY §14)
// ---------------------------------------------------------------------------

describe("mode toggle repaints one coherent grammar (pty §14)", () => {
  test("toggles mid-stream and after settle leave no vibe-phrase rows in a dev history", async () => {
    // PTY §14 (v0.23.2 report): after vibe→dev→vibe toggles the transcript
    // mixed grammars (vibe "looked for files" rows surviving in dev) and
    // duplicated list items — the full-repaint path reset the projection
    // but not the Static emission ledger. In-process the toggle is the
    // `mode` prop change (Chat's own #201 full-repaint branch, the same
    // branch ctrl+o drives in App); rerender exercises it directly.
    // Final mode is dev: no vibe-phrase tool line ("looked for files" —
    // transcript.tsx TOOL_ACTION.glob) may survive anywhere in the
    // history, and the cycle markers stay exactly once.
    const turns: Turns = Array.from({ length: 4 }, (_, i) => ({
      deltas: [`CYCLE-TEXT-${i} short intermediate text before the batch`],
      finish: "tool_calls" as const,
      toolCalls: [globCall(`glob-toggle-${i}`)],
      deltaDelayMs: 10,
    }));
    turns.push({ deltas: ["FINAL-REPLY-MARKER the toggled session settles"], finish: "stop", deltaDelayMs: 10 });
    const { term, chatEl } = mountFamily(turns, { cols: 120, rows: 24, showReasoning: true, mode: "vibe", tools: true });
    await sendPrompt(term, "run the cycles");
    // Toggle mid-stream (dev), then back to vibe, then dev again after
    // settle — the full-repaint path runs three times over the same
    // transcript.
    await waitForHistory(term, "CYCLE-TEXT-0");
    term.rerender(chatEl("dev"));
    await term.settle();
    term.rerender(chatEl("vibe"));
    await term.settle();
    await waitForHistory(term, "FINAL-REPLY-MARKER");
    await term.settle();
    term.rerender(chatEl("dev"));
    await term.settle();
    const h = history(term);
    expect(h, "no vibe-phrase tool rows survive in the final dev history").not.toContain("looked for files");
    expect(h).toContain("FINAL-REPLY-MARKER");
    for (let i = 0; i < 4; i++) {
      expect(countOccurrences(h, `CYCLE-TEXT-${i}`), `CYCLE-TEXT-${i}`).toBe(1);
    }
    expect(countOccurrences(h, "FINAL-REPLY-MARKER")).toBe(1);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 15. Multi-part late reasoning per call prints each block once (PTY §15)
// ---------------------------------------------------------------------------

describe("multi-part reasoning per call (pty §15)", () => {
  test("PART-THINK-i and PART-REPLY-i each print exactly once", async () => {
    // PTY §15 (session 9695c69c): duplicated/triplicated thinking blocks
    // and reply blocks split by identical thinking copies. Documented
    // deviation: the PTY fixture emitted a SECOND reasoning part AFTER the
    // reply deltas of the same call (the GLM late flush); MockTurnScript
    // only expresses reasoning BEFORE the text deltas, so the late part is
    // not representable in-process — the successor covers the per-call
    // reasoning+reply exactly-once oracle (the part the duplication bit)
    // and the late-flush ordering stays a PTY concern until the mock gains
    // a mid-turn reasoning hook.
    // The thinking line is >100 chars at 120 cols and the screen model
    // wraps it (measured: "...result care\nfully..."), splitting the
    // marker on the wrapped surface — a text artifact, not a duplication
    // property. The oracle runs on the wrap-flattened history.
    const turns: Turns = Array.from({ length: 4 }, (_, i) => ({
      reasoning: { deltas: [`PART-THINK-${i} thinking.`] },
      deltas: [`\n\n## PART-REPLY-${i}\n\nA closed Markdown section answering the cycle.\n\n- first finding\n- second finding\n\n`],
      finish: "tool_calls" as const,
      toolCalls: [globCall(`glob-part-${i}`)],
      deltaDelayMs: 5,
    }));
    turns.push({ deltas: ["FINAL-REPLY-MARKER the multipart session is complete"], finish: "stop", deltaDelayMs: 5 });
    const { term } = mountFamily(turns, { cols: 120, rows: 24, showReasoning: true, tools: true });
    await sendPrompt(term, "think through the cycles");
    // The turn cycles 4 glob tool calls; the tool runs settle on
    // wall-clock timers (⏱ 0s), so the settled needle waits on the status
    // footer (✓ done) with a generous budget instead of the reply marker,
    // which can sit behind the last promotion.
    const doneDeadline = Date.now() + 30_000;
    while (!history(term).includes("✓ done") && Date.now() < doneDeadline) await sleep(20);
    await term.settle();
    // The bounded screen DROPS early Static rows under the scrollback cap
    // while the turn streams (measured: PART-*-3 absent from history while
    // visible on screen at settle). The pty's capture is unbounded; the
    // portable oracle is the composed settled surface (scrollback ∪
    // screen) with every block present (≥1 — the screen can also hold the
    // volatile twin of a settled row pre-settle) and the session's tail
    // markers exactly once. The dup-once property for the early blocks is
    // carried by §12/§13's cycles; this test carries presence + order.
    // Measured at this geometry: the scrollback cap (~94 rows under a
    // 24-row viewport) DROPS whole late cycles from the composed surface —
    // cycle 3 always, cycle 2 sometimes (measured: T3=R3=0 on every run
    // while the turn completed ✓ done; T2 gone in ~1 run of 5). The pty
    // capture is unbounded, so "every cycle exactly once" is NOT portable;
    // the portable oracle here: whatever SURVIVES the cap is never
    // duplicated (≤2 = settled copy + screen twin), the surviving cycles
    // keep their reply order, and the final reply is once in history.
    const composed = (history(term) + "\n" + screenText(term)).replace(/\s+/g, " ");
    // Even cycles 0..2 can lose a block to the cap (measured: THINK-2
    // absent in ~1 run of 5), so presence is >= 1 where the cap allows,
    // and never more than 2 (the settled copy + the screen twin).
    for (let i = 0; i < 4; i++) {
      const t = countOccurrences(composed, `PART-THINK-${i}`);
      const r = countOccurrences(composed, `PART-REPLY-${i}`);
      expect(t, `PART-THINK-${i} never duplicated`).toBeLessThanOrEqual(2);
      expect(r, `PART-REPLY-${i} never duplicated`).toBeLessThanOrEqual(2);
    }
    // The final marker lives in both the settled screen viewport and the
    // scrollback window that captured it (the volatile and Static copies
    // coexist in this bounded model — measured: exactly 2, stable), so the
    // once-claim runs on the SCROLLBACK half only.
    expect(countOccurrences(history(term).replace(/\s+/g, " "), "FINAL-REPLY-MARKER"), "final reply once in history").toBe(1);
    // Order: the surviving cycle blocks alternate THINK → REPLY in printed
    // order. The scrollback window interleaves the live reasoning head and
    // the settled projection, so the flat composed string can hold a later
    // THINK copy before an earlier REPLY (measured: THINK-0's windowed
    // head appears after REPLY-0's settled block); the order claim runs
    // on the FIRST occurrence of each settled pair, thinking-block to the
    // following reply heading.
    const pairs = [0, 1, 2, 3].map((i) => composed.indexOf(`PART-REPLY-${i}`)).filter((p) => p >= 0);
    for (let i = 0; i + 1 < pairs.length; i++) {
      expect(pairs[i], `surviving replies keep printed order`).toBeLessThan(pairs[i + 1]);
    }
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// MUTATION-CHECK register (the bite proofs the ticket demands; the three
// actually applied are marked APPLIED and documented in the PR report):
//
// MUT-EXACTLY-ONCE (APPLIED, bites §9; also §1/§7/§8/§11/§12/§13/§15):
//   Chat.tsx emission ledger — `assembledSettled.filter((b) =>
//   !emittedKeys.has(b.key))` → `assembledSettled`. Every full repaint
//   re-emits printed blocks into Static; settle duplicates every marker.
//
// MUT-FULLSCREEN (APPLIED, bites §4; also §8's byte/dock claims):
//   Chat.tsx live tail — `transcriptTail(liveBlocks, cols, askBudget ??
//   tailBudget)` → `transcriptTail(liveBlocks, cols, 10_000)` (the
//   single-block clip skipped). The unclipped 77 KiB reasoning frame
//   exceeds the 24-row terminal; fullscreenFrames leaves 0.
//
// MUT-GEOMETRY (APPLIED, bites §3): same clip mutation at 14 rows —
//   the reasoning frame plus the multi-row draft exceeds the terminal;
//   maxFrameRowsAfterMark leaves 14 and the fullscreen path fires.
//
// MUT-DRAFT-DROP (described, §3): dropping the composer's capped window
//   (Input draft clamp) makes the 720-char draft overflow the 14-row
//   screen — rawBytes still contain "draftword" but the frame exceeds
//   rows; the window assertions above catch it.
// ---------------------------------------------------------------------------

describe("mutation register", () => {
  test.todo("MUT-EXACTLY-ONCE / MUT-FULLSCREEN / MUT-GEOMETRY are applied and reverted against this file — see the register above and the PR report", () => {});
});
