import { describe, expect, test } from "bun:test";
import { hasPython, runPtyRaw } from "./pty-runner";
import { COMPOSER_COMPACT, COMPOSER_READY } from "../helpers";

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
  // UNBLOCKING EVIDENCE (2026-09-25): #441 was load exposure, and the PTY
  // block no longer overlaps the component suite (scripts/test.sh), so the
  // test was re-run unskipped: 3/3 green at 32.5s (variance <200ms), inside
  // the 45s harness kill.
  //
  // Not unskipped yet: on CI's 2-vCPU runner the same script needs a wider
  // margin than a local 8-core run can testify to, and #441 shipped exactly
  // that failure. To restore, delete `.skip` below and confirm the tui-pty
  // job stays green; the fallback if it does not is dropping the third turn
  // (its only role is screen fill, and the final assertions already pass
  // with the two replies that remain visible) plus 3s settle budgets.
  //
  // Per-turn note: the demo provider answers the same canned text every
  // turn, so the bare `until: "Hello from moh"` after turns 2 and 3 burns its
  // whole budget before drawing (pump_until matches only past the current
  // buffer offset, and an earlier reply is already painted) — 12s of the
  // 32.5s is that standby. Turn 1's needle does match, being a fresh paint.
  test.skip("settings open/close: input and bottom bar stay on the bottom rows", async () => {
    const meta = await runPtyRaw({
      cols: 100,
      rows: 30,
      config: { onboarded: true, workflowOffered: true, mode: "dev" },
      project: { provider: "mock" },
      steps: [
        { wait: 2.0 },
        { wait: 0.3, send: B("\r") }, // home → new session (mock provider)
        { wait: 5.0, until: COMPOSER_READY }, // chat input rendered
        // Three settled turns: enough transcript to fill the screen and pin
        // the frame to the bottom rows before the modal cycle. The readiness
        // needle is the mock reply itself; `pump_until` matches only past the
        // current buffer offset, so what each turn waits for is its own fresh
        // repaint (styled turn counters like `↻ 1` are split by SGR codes in
        // the raw stream and cannot be matched contiguously). The demo
        // provider answers the same canned text every turn: when the frame is
        // repainted the earlier replies are re-emitted too, so a generous
        // budget is the standby, not a uniqueness claim.
        { wait: 0.3, send: B("one") },
        { wait: 0.4, send: B("\r") },
        { wait: 4.0, until: "Hello from moh" },
        { wait: 0.3, send: B("two") },
        { wait: 0.4, send: B("\r") },
        { wait: 4.0, until: "Hello from moh" },
        { wait: 0.3, send: B("three") },
        { wait: 0.4, send: B("\r") },
        { wait: 4.0, until: "Hello from moh" },
        { wait: 0.4, send: B("world") }, // unsent text marks the input row
        { wait: 0.6 },
        { wait: 0.8, send: B("\x13") }, // ctrl+s → settings (alt screen)
        { wait: 8.0, until: "Default permission mode" },
        { wait: 0.5, send: B("\x1b") }, // esc → close, frame restored
        { wait: 1.5 }, // > delayed buffer flip (ALT_FLIP_DELAY_MS)
      ],
      tail: 30,
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
    expect(lines.filter((line) => line.text.includes("Hello from moh")).length).toBeGreaterThanOrEqual(2);
  }, 90_000);
});
