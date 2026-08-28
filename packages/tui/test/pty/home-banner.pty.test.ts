import { describe, expect, test } from "bun:test";
import { hasPython, runPtyRaw } from "./pty-runner";

/**
 * Home chrome on a tall terminal (#292): the figlet-Slant banner with the
 * "My Own Harness" acronym, the version number centered under it, and no
 * inline logo fallback. Component tests run at the 24-row fallback viewport,
 * so the banner mode is only observable here (rows ≥ 30).
 */
describe.skipIf(!hasPython)("home banner on a tall terminal (PTY)", () => {
  test("shows the slant banner, acronym, and version under it", async () => {
    const meta = await runPtyRaw({
      cols: 100,
      rows: 40,
      config: { onboarded: true, workflowOffered: true, mode: "dev" },
      project: { provider: "mock" },
      steps: [{ wait: 3.0, until: "New session" }],
      tail: 40,
    });
    const text = meta.lines.map((line) => line.text).join("\n");
    // Banner art (slant 'm') + acronym below it…
    expect(text).toContain("/ /_");
    expect(text).toContain("My Own Harness");
    // …version centered under the acronym, not the footer fallback…
    expect(text).toContain("v0.1.0");
    expect(text).not.toContain("v0.1.0 · ");
    // …and no inline one-line logo on a tall terminal.
    expect(text).not.toContain("moh > — My Own Harness");
  }, 60_000);
});
