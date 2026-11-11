import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
      steps: [{ wait: 10.0, until: "New session" }],
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


describe.skipIf(!hasPython)("startup color capabilities (#1738)", () => {
  for (const truecolor of [false, true]) {
    test(`${truecolor ? "truecolor" : "Apple Terminal 256-color"}: startup and home input emit supported SGR only`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "moh-home-colors-"));
      const rawDump = join(dir, "terminal.bin");
      try {
        const meta = await runPtyRaw({
          cols: 100, rows: 40,
          config: { onboarded: true, workflowOffered: true, mode: "vibe", theme: "amiga-workbench13" },
          project: { provider: "mock" },
          env: { TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455.1", COLORTERM: truecolor ? "truecolor" : "", FORCE_COLOR: "2", NO_COLOR: "" },
          steps: [
            { wait: 10, until: "New session", untilOnScreen: true },
            { send: btoa("image.png") },
            { wait: 5, until: "image.png", untilOnScreen: true },
          ],
          rawDump, tail: 40,
        });
        expect(meta.lines.map(line => line.text).join("\n")).toContain("image.png");
        const bytes = readFileSync(rawDump, "utf8");
        expect(bytes).toMatch(/\x1b\[38;/);
        if (truecolor) expect(bytes).toMatch(/\x1b\[38;2;/);
        else {
          expect(bytes).not.toMatch(/\x1b\[(?:38|48);2;/);
          expect(bytes).toMatch(/\x1b\[38;5;/);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 60_000);
  }
});
