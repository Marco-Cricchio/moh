import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPtyRaw } from "./pty-runner";
import { startFakeOpenAiTurns } from "./fake-openai-turns";

/**
 * Modal-return anchor regression (live session 2026-08-27): after a modal
 * cycle in the alternate screen (model picker / settings / commands…), the
 * restored session frame must repaint in place — input row and bottom bar
 * anchored to the bottom rows of the physical screen.
 *
 * Root cause: ink's log-update tracks the line count of the frame painted
 * in the *active* buffer. The modal frame is fullscreen (~rows lines); on
 * close the buffer flip (?1049l) restored the main buffer while ink's count
 * still described the modal frame, so the first post-close paint erased
 * ~rows lines from the restored cursor — clearing the whole screen — and
 * rewrote the short session frame from the top. The transcript and input
 * "jumped up". App.tsx now commits the native frame into the dying
 * alternate buffer (resyncing ink's count) before flipping back.
 *
 * The PTY harness models the alternate screen (harness.py), so the final
 * screen reflects what the user actually sees after the modal closes. The
 * transcript must be long enough to fill the screen and pin the interactive
 * frame to the bottom rows — that is the layout the bad erase destroyed.
 */
const B = (s: string) => btoa(s);

describe.skipIf(!hasPython)("modal open/close keeps the session frame anchored (PTY)", () => {
  // Level 2 (#1061, step C): the alternate screen and its restoration on
  // exit are exactly what this file is for — a real process on a real pty
  // flipping ?1049 in and out. The regression it guards (live session
  // 2026-08-27) is app-side: ink's log-update tracks the line count of the
  // frame painted in the ACTIVE buffer, so if the first post-close paint ran
  // in the main buffer with the modal frame's stale count, its
  // eraseLines(~rows) cleared the restored screen and the chat "jumped up".
  //
  // Previously test.skip: it was unskippable on CI's 2-vCPU runner because
  // its readiness waits were the mock provider's identical reply text plus
  // fixed settle budgets (#441 was exactly that load exposure). The waits
  // are needles now — the app's own home row and this fixture's per-turn
  // `TURN-n-MARKER` — so the script has no budget that a slow host can
  // consume, which is the condition the old comment asked for.
  //
  // The in-process fake terminal models ?1049 (screen.ts), but its verdict
  // is NOT a substitute: driven by an overlay cycle it stays green even when
  // the app's resync write is removed (measured — the model restores the
  // grid the app never let it lose), so the anchor claim belongs here.
  test("settings open/close: input and bottom bar stay on the bottom rows", async () => {
    const { server, url } = startFakeOpenAiTurns(3);
    try {
      const meta = await runPtyRaw({
        cols: 100,
        rows: 30,
        config: {
          onboarded: true, workflowOffered: true, mode: "dev",
          provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        steps: [
          // Readiness is a needle only this run's configuration can paint:
          // the app's own home row, not a sleep.
          { wait: 8.0, until: "New session", untilOnScreen: true },
          // Two settled turns, each proved by its own unique marker (#1061:
          // the fixture answers TURN-n-MARKER, so a wait cannot be satisfied
          // by an earlier turn's reply).
          { wait: 0.3, send: B("one") },
          { wait: 0.4, send: B("\r") },
          { wait: 10.0, until: "TURN-1-MARKER", untilOnScreen: true },
          { wait: 0.3, send: B("two") },
          { wait: 0.4, send: B("\r") },
          { wait: 10.0, until: "TURN-2-MARKER", untilOnScreen: true },
          { wait: 0.4, send: B("world") }, // unsent text marks the input row
          // The resize signal is the readiness for the frame being settled:
          // no fixed settle budget stands between the two turns and the
          // modal cycle.
          { wait: 0.6, send: B("\x13") }, // ctrl+s → settings (alt screen)
          { wait: 8.0, until: "Default permission mode", untilOnScreen: true },
          { wait: 0.5, send: B("\x1b") }, // esc → close, frame restored
        ],
        tail: 30,
        rawDump: "/tmp/moh-modal-return-anchor.bin",
      });
      const lines = meta.lines;
      const inputRow = lines.findIndex((line) => line.text.includes("world"));
      expect(inputRow).toBeGreaterThanOrEqual(0); // input row is on screen
      // The chips row sits at the bottom of the frame; ink parks the cursor
      // one row below it (trailing '\n' of a non-fullscreen frame), so the
      // chips are the last non-empty screen row — never near the top.
      let chipsRow = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.text.includes("send")) { chipsRow = i; break; }
      }
      expect(chipsRow).toBeGreaterThanOrEqual(lines.length - 2);
      // …and the input row must sit inside the bottom chrome (separator,
      // input, separator, spacer, status, chips) — never near the top.
      expect(inputRow).toBeGreaterThanOrEqual(lines.length - 8);
      expect(inputRow).toBeLessThan(chipsRow); // input above the chips
      // The transcript survived the cycle: earlier replies still fill the
      // screen above the frame — not erased by a wrongly-anchored repaint.
      const all = [...(meta.scrollback ?? []), ...lines].join("\n");
      expect(all).toContain("TURN-1-MARKER");
      // The final Screen snapshot is the restored main buffer; its bounded
      // scrollback may legitimately have discarded the second marker while
      // the modal's alternate buffer was active. The raw PTY capture is the
      // cumulative process-boundary authority for the transcript surviving
      // the cycle.
      const raw = readFileSync("/tmp/moh-modal-return-anchor.bin", "utf8");
      expect(raw).toContain("TURN-2-MARKER");
    } finally {
      server.stop(true);
    }
  }, 90_000);

});
