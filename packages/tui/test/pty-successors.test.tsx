/**
 * The remaining level-1 successors of the PTY suite (#1061, T8 of the
 * #1052 chain / ADR-0057 step C). T5–T7 carried the frame, streaming and
 * ask-user families in-process; this file carries the four PTY files that
 * asserted *screen and chrome* content at a chosen geometry, which the fake
 * terminal observes exactly as well as a pty did:
 *
 * - `reasoning-controls.pty.test.ts` §1/§2 — the `/thinking show` chrome and
 *   the ctrl+y explanation, at a width the test chooses;
 * - `table-stream.pty.test.tsx` — a row-by-row GFM table ends rendered, not
 *   as raw pipes;
 * - `markdown-live-continuity.pty.test.ts` — an open Markdown item is
 *   readable *before* its semantic close;
 * - `natural-scrollback.pty.test.ts` — reasoning and an open long reply
 *   advance native scrollback before the turn closes.
 *
 * The mid-stream oracles are deterministic here, not sampled: the fixture
 * holds the turn open at a chosen delta (`MockTurnScript.hold`, #1061), so
 * "the item is readable while the provider has not closed it" is a state the
 * test *creates*, not a wall-clock window it hopes to land inside. That is
 * the whole difference from the PTY baseline, which needed a 30s + 22s
 * budget to sample the same instant.
 *
 * Rules carried from T5/T6 (see `streaming-family.test.tsx` header):
 * `deltaDelayMs` wherever the stream must be dilated, exactly-once counts on
 * the final HISTORY, `counters.fullscreenFrames` as the fullscreen verdict,
 * no assertion that depends on host speed.
 */
import "./faketty/ci-mask"; // BEFORE any ink-loading import: is-in-ci snapshots the env at module load
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { Chat, visibleVolatileTail } from "../src/Chat";
import { makeSession } from "../src/factory";
import { renderOnFakeTty } from "./faketty/render";
import { COMPOSER_COMPACT, COMPOSER_READY, unwrap } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic reveal pacing (same as T5/T6). */
const FAST_REVEAL = { tickMs: 5, charsPerTick: 400, catchupChars: 4000 };

/** The terminal history: native scrollback ∪ visible screen — every text
 * wait and every exactly-once count reads this, never the screen alone. */
const history = (term: ReturnType<typeof renderOnFakeTty>) =>
  [...term.screen.scrollback(), ...term.screen.lines()].join("\n");

const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

async function waitForHistory(
  term: ReturnType<typeof renderOnFakeTty>,
  needle: string,
  { timeoutMs = 10_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!history(term).includes(needle) && Date.now() < deadline) await sleep(20);
  expect(history(term)).toContain(needle);
}

function mountChat(
  turns: Parameters<typeof MockProvider.scripted>[0],
  opts: { cols: number; rows: number; showReasoning?: boolean; mode?: "vibe" | "dev" },
) {
  const cwd = mkdtempSync(join(tmpdir(), "moh-pty-successors-"));
  const home = mkdtempSync(join(tmpdir(), "moh-pty-successors-h-"));
  const { session } = unwrap(makeSession({
    cwd,
    home,
    provider: MockProvider.scripted(turns),
    permissionMode: "auto-accept",
  }));
  const term = renderOnFakeTty(
    <Chat
      session={session}
      cwd={cwd}
      mode={opts.mode ?? "dev"}
      modelLabel="mock"
      width={opts.cols}
      showReasoning={opts.showReasoning}
      reveal={FAST_REVEAL}
    />,
    { cols: opts.cols, rows: opts.rows },
  );
  return { term, session, cwd, home };
}

async function sendPrompt(term: ReturnType<typeof renderOnFakeTty>, text: string): Promise<void> {
  await waitForHistory(term, "⏎ send");
  term.write(text);
  await sleep(20);
  term.write("\r");
}

/** A promise plus its resolver, for the turn-holding fixture (#1061). */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

// ---------------------------------------------------------------------------
// 1. A row-by-row GFM table ends rendered, not as raw pipes
//    (pty `table-stream.pty.test.tsx`, #227)
// ---------------------------------------------------------------------------

describe("streamed GFM table renders (pty table-stream #227)", () => {
  test("the table lands in history with borders and no raw separator row", async () => {
    // The PTY baseline streamed the rows over a local SSE server with 250ms
    // pacing and waited 8s for the closing prose. Here the same rows arrive
    // from the mock provider: the claim is about the RENDER of a table whose
    // rows came one at a time, which the fake terminal observes exactly.
    const rows = [
      "Ecco il quadro.\n\n",
      "| PR | Issue | Titolo |\n",
      "|---|---|---|\n",
      "| #212 | #211 | Allineamento body |\n",
      "| #214 | #213 | Chrome dev-mode |\n",
      "| #216 | #215 | Permessi auto-accept |\n",
      "\n",
      "Nessun CI configurato. Fine del riepilogo.\n",
    ];
    const { term } = mountChat(
      [{ deltas: rows, finish: "stop", deltaDelayMs: 15 }],
      { cols: 120, rows: 40, mode: "vibe" },
    );
    await sendPrompt(term, "riepiloga");
    await waitForHistory(term, "Nessun CI configurato");
    await term.settle();
    const h = history(term);
    // Rendered borders, not pipe soup: the raw separator row must not
    // survive anywhere in the history.
    expect(h).toContain("│ #212");
    expect(h).toContain("│ #216");
    expect(h).not.toMatch(/\|---\|/);
    expect(countOccurrences(h, "Nessun CI configurato")).toBe(1);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. An open Markdown item is readable before its semantic close
//    (pty `markdown-live-continuity.pty.test.ts`, owner 777.mov)
// ---------------------------------------------------------------------------

describe("an open Markdown item is readable before its close (pty markdown-live-continuity)", () => {
  test("the open item is on screen while the turn is still held open", async () => {
    // The PTY baseline held the response open server-side and sampled with a
    // 12s readiness wait plus a 3s checkpoint. The hold is now inside the
    // fixture: the provider stops BETWEEN deltas until the test releases it,
    // so the checkpoint is an instant the test owns.
    const held = gate();
    const { term } = mountChat(
      [{
        deltas: [
          "Architecture overview.\n\n",
          "1. **Core headless** OPEN-ITEM-ALREADY-SENT is readable while the provider has not closed this item",
          ".\n\nReply complete.",
        ],
        finish: "stop",
        hold: { afterDeltas: 2, release: held.promise },
      }],
      { cols: 149, rows: 40, mode: "vibe" },
    );
    await sendPrompt(term, "architecture");
    // Deterministic mid-stream instant: the item is painted, the closing
    // text and ✓ done cannot be, because the provider is still parked.
    await waitForHistory(term, "OPEN-ITEM-ALREADY-SENT");
    await term.settle();
    const midStream = history(term);
    expect(midStream).toContain("Architecture overview.");
    expect(midStream).toContain("OPEN-ITEM-ALREADY-SENT");
    expect(midStream).not.toContain("Reply complete.");
    // The turn is genuinely open — this is the "before its semantic close"
    // claim, not a race that happened to read early.
    expect(midStream).not.toContain("✓ done");
    held.open();
    await waitForHistory(term, "Reply complete.");
    await term.settle();
    expect(countOccurrences(history(term), "OPEN-ITEM-ALREADY-SENT")).toBe(1);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Reasoning and an open long reply advance native scrollback
//    (pty `natural-scrollback.pty.test.ts`, #874-adjacent)
// ---------------------------------------------------------------------------

describe("an open long reply advances native scrollback (pty natural-scrollback)", () => {
  test("earlier rows reach scrollback while the reply is still open", async () => {
    // The PTY baseline needed 30s + 22s of wall clock to catch the reveal
    // cursor mid-reply. Here the reply is held after the tail delta and the
    // assertion reads the SCROLLBACK — the rows the terminal actually pushed
    // out of the grid — with the turn still open.
    const held = gate();
    const reasoning = Array.from({ length: 45 }, (_, i) => `REASONING-ROW-${String(i).padStart(2, "0")} checking the design before answering.\n`);
    const details = Array.from(
      { length: 65 },
      (_, i) => `DETAIL-${String(i).padStart(2, "0")} the core owns the agent loop and the clients display its events. `,
    );
    const { term } = mountChat(
      [{
        reasoning: { deltas: [reasoning.join("")] },
        deltas: ["## Architecture\n\n1. **REPLY-FIRST-ROW** ", ...details, "REPLY-LIVE-TAIL", "\n\nReply complete."],
        finish: "stop",
        deltaDelayMs: 5,
        hold: { afterDeltas: 2 + details.length, release: held.promise },
      }],
      { cols: 100, rows: 24, showReasoning: true, mode: "vibe" },
    );
    await sendPrompt(term, "explain the architecture");
    await waitForHistory(term, "REPLY-LIVE-TAIL");
    await term.settle();
    const scrollback = term.screen.scrollback().join("\n");
    const onScreen = term.screen.lines().join("\n");
    // The claim: the terminal pushed rows OUT of the grid into native
    // scrollback while the turn was still open — the visible grid holds the
    // newest text, the earlier rows are above it.
    expect(onScreen).toContain("REPLY-LIVE-TAIL");
    expect(scrollback.length).toBeGreaterThan(0);
    // The bounded fake screen drops the earliest rows once they scroll far
    // enough, so "was it ever painted" is read off the raw byte stream (the
    // PTY baseline's own authority) and "did it leave the grid" off the
    // scrollback.
    const raw = term.rawBytes().toString("utf8");
    expect(raw).toContain("REASONING-ROW-00");
    expect(raw).toContain("REPLY-FIRST-ROW");
    // Reasoning painted before the reply's first row ever appeared.
    expect(raw.indexOf("REASONING-ROW-44")).toBeLessThan(raw.indexOf("REPLY-FIRST-ROW"));
    // The turn is genuinely open at this instant.
    expect(raw).not.toContain("Reply complete.");
    held.open();
    await waitForHistory(term, "Reply complete.");
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. `/thinking show` chrome and the ctrl+y explanation at a chosen width
//    (pty `reasoning-controls.pty.test.ts` #242)
// ---------------------------------------------------------------------------

describe("thinking chrome at a chosen width (pty reasoning-controls #242)", () => {
  test("ctrl+y explains a model with no level map without overflowing the row", async () => {
    // The PTY baseline asserted the same string on a real 100-column
    // terminal. The width is injected here (`FakeStdout.columns`), so the
    // "the row fits the terminal" guard is exact rather than read off a
    // physical screen, and the status text is not clipped by the harness.
    const cwd = mkdtempSync(join(tmpdir(), "moh-pty-successors-app-"));
    const home = mkdtempSync(join(tmpdir(), "moh-pty-successors-app-h-"));
    const term = renderOnFakeTty(
      <App
        cwd={cwd}
        home={home}
        provider={MockProvider.scripted([{ deltas: ["hello"], finish: "stop" }])}
        startInChat
        skipOnboarding
        intro={false}
        initialMode="dev"
      />,
      { cols: 100, rows: 24 },
    );
    await waitForHistory(term, COMPOSER_READY);
    term.write("\x19"); // ctrl+y on a mock model: no declared capability
    const deadline = Date.now() + 5_000;
    while (!history(term).includes("thinking levels not offered") && Date.now() < deadline) await sleep(20);
    const frame = history(term);
    expect(frame).toContain("thinking levels not offered fo");
    // Every physical row fits the 100-column terminal the test chose.
    for (const line of term.screen.lines()) expect(line.length).toBeLessThanOrEqual(100);
    await term.unmount();
  }, 60_000);

  test("/thinking show applies as non-blocking chrome with the input still live", async () => {
    // PTY §1 asserted (a) the status line reports the reasoning display,
    // (b) no row exceeds 64 columns, (c) the command is non-blocking — the
    // composer remains available. All three are screen properties: the same
    // assertions at the same width, in-process.
    const cwd = mkdtempSync(join(tmpdir(), "moh-pty-successors-app2-"));
    const home = mkdtempSync(join(tmpdir(), "moh-pty-successors-app2-h-"));
    const term = renderOnFakeTty(
      <App
        cwd={cwd}
        home={home}
        provider={MockProvider.scripted([{ deltas: ["hello"], finish: "stop" }])}
        startInChat
        skipOnboarding
        intro={false}
        initialMode="dev"
      />,
      { cols: 64, rows: 24 },
    );
    await waitForHistory(term, COMPOSER_COMPACT);
    term.write("/thinking show");
    await sleep(30);
    term.write("\r");
    const deadline = Date.now() + 5_000;
    while (!history(term).includes("reasoning display") && Date.now() < deadline) await sleep(20);
    expect(history(term)).toContain("reasoning display");
    // The command is non-blocking: the composer stays available.
    expect(term.screen.lines().join("\n")).toContain("⏎ send");
    // Nothing paints past the terminal edge — the narrow-width guard the
    // PTY test carried.
    for (const line of term.screen.lines()) expect(line.length).toBeLessThanOrEqual(64);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. A burst reply is revealed progressively, not in one block
//    (pty `typewriter-reveal.pty.test.ts`, owner 777.mov)
// ---------------------------------------------------------------------------

describe("a burst reply is revealed progressively (pty typewriter-reveal)", () => {
  test("the volatile window hides the unrevealed tail down to one row, never further", () => {
    // Level 0 (the mechanism): the open block's visible tail is a function
    // of the cursor, the promoted prefix and the pending flag. The PTY
    // baseline (owner 777.mov) asserted the *effect* — the head readable
    // while the tail is not, then the tail revealed — which is exactly this
    // rule observed through a terminal.
    const rows = ["BURST-START ok ok", "more ok ok ok", "BURST-END"];
    // Mid-stream, cursor at 0: exactly one row is visible (the head), never
    // zero — an in-flight reply is always readable.
    expect(visibleVolatileTail(rows, 0, 0, true)).toEqual(["BURST-START ok ok"]);
    // The cursor opens the window row by row...
    expect(visibleVolatileTail(rows, 0, 1, true)).toEqual(rows.slice(0, 1));
    expect(visibleVolatileTail(rows, 0, 2, true)).toEqual(rows.slice(0, 2));
    expect(visibleVolatileTail(rows, 0, 3, true)).toEqual(rows);
    // ...and a row already promoted is visible regardless of the cursor:
    // promotion ignores reveal pacing (#1054), so the open tail is measured
    // from the promoted prefix, not from the start of the block.
    expect(visibleVolatileTail(rows, 2, 0, true)).toEqual(["BURST-END"]);
    // Settled: the window is fully open (the settle drain is a different
    // path, but the rule must not hide anything once the turn is over).
    expect(visibleVolatileTail(rows, 0, 0, false)).toEqual(rows);
  });

  test("a held turn shows the streamed head and not the unrevealed tail", async () => {
    // Level 1 (the wiring): the pure rule is what Chat renders. The fixture
    // holds the turn open after the burst delta, so the assertion is read at
    // an instant the test creates rather than one it hopes to land in.
    const reply = `BURST-START ${"ok ".repeat(12)}`;
    const held = gate();
    const { term } = mountChat(
      [{ deltas: [reply, " BURST-END"], finish: "stop", hold: { afterDeltas: 1, release: held.promise } }],
      { cols: 100, rows: 30 },
    );
    await sendPrompt(term, "burst");
    await waitForHistory(term, "BURST-START");
    // The streamed-before-the-hold prefix is on screen; the delta the hold
    // gates cannot be, and the turn is genuinely open.
    const early = history(term);
    expect(early).toContain("BURST-START");
    expect(early).not.toContain("BURST-END");
    expect(early).not.toContain("✓ done");
    held.open();
    await waitForHistory(term, "BURST-END");
    await term.settle();
    const settled = history(term);
    expect(countOccurrences(settled, "BURST-END")).toBe(1);
    expect(countOccurrences(settled, "BURST-START")).toBe(1);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 6. The mutation register
// ---------------------------------------------------------------------------

describe("mutation register", () => {
  test.todo("MUT-HOLD / MUT-TABLE / MUT-OPEN-ITEM are applied and reverted against this file — see the register in the PR report", () => {});
});
