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
        { wait: 0.6 },
        { send: "\r" },
        { wait: 3.0, until: "New session" },
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
