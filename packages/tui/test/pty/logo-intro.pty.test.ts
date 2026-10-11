import { describe, expect, test } from "bun:test";
import { hasPython, runPtyRaw } from "./pty-runner";

/**
 * The splash intro stays inside the viewport (#1304): at 100×30 the banner
 * gate is open (rows ≥ 30), so a random-font splash banner animates — and
 * every intro frame must fit without overflow. The intro ends on any key.
 */
describe.skipIf(!hasPython)("splash intro on a tall terminal (PTY)", () => {
  test("intro frames fit the viewport and a key skips to the settled home", async () => {
    const meta = await runPtyRaw({
      cols: 100,
      rows: 30,
      config: { onboarded: true, workflowOffered: true, mode: "dev" },
      project: { provider: "mock" },
      steps: [
        // #1332: the skip key goes first, while the intro is guaranteed
        // active (it settles at ~3.15s; the harness's 2.5s boot pump ends
        // well before). The old shape (0.6s wait, then key, then a
        // since-guarded wait for the settled home) was structurally
        // race-prone: on a slow host the intro fully settles inside the
        // boot pump, "New session" is painted BEFORE the until step starts
        // and the since guard can never match — the 6s budget burns to
        // expiry (#1326's widening could not fix that).
        { send: "\r" },
        { wait: 6.0, until: "New session", untilFromBuffer: true },
      ],
      tail: 30,
    });
    const text = meta.lines.map((line) => line.text).join("\n");
    // Any keystroke ends the intro: the settled home is on screen.
    expect(text).toContain("New session");
    // The settled screen must not have scrolled the frame: the header rows
    // are still the top of the screen (nothing pushed the layout down).
    expect(meta.lines.length).toBeLessThanOrEqual(30);
  }, 60_000);
});
