import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEV_CONFIG, hasPython, runPtyRaw } from "./pty-runner";

/**
 * Home at small terminal heights (#1023): the home's own layout used to be
 * taller than the terminal at rows ≤ 18, so ink took the fullscreen path on
 * EVERY Home frame — clearTerminal (screen + native scrollback wipe)
 * followed by a full reprint, at render cadence. The vertical degradation
 * tiers (padding, blank spacers, hint lines) keep `outputHeight < rows` so
 * the Home window runs on the log-update path like the chat.
 */
describe.skipIf(!hasPython)("home at small terminal heights (PTY)", () => {
  test("rows = 14: zero clearTerminal while sitting on Home", async () => {
    const rawDump = `${import.meta.dir}/.tmp-home-compact-14.bin`;
    const meta = await runPtyRaw({
      cols: 80,
      rows: 14,
      config: DEV_CONFIG,
      project: { provider: "mock" },
      seedSessions: 2,
      steps: [{ wait: 4.0, until: "New session" }],
      rawDump,
      tail: 20,
    });
    const text = meta.lines.map((line) => line.text).join("\n");
    // The frame must still be actionable, never blank…
    expect(text).toContain("My Own Harness");
    expect(text).toContain("New session");
    // …and the whole Home window runs on the log-update path: no wipe.
    expect(readFileSync(rawDump, "utf8").split("\x1b[2J\x1b[3J\x1b[H").length - 1).toBe(0);
  }, 90_000);

  test("rows = 18: zero clearTerminal while sitting on Home", async () => {
    const rawDump = `${import.meta.dir}/.tmp-home-compact-18.bin`;
    await runPtyRaw({
      cols: 80,
      rows: 18,
      config: DEV_CONFIG,
      project: { provider: "mock" },
      seedSessions: 2,
      steps: [{ wait: 4.0, until: "New session" }],
      rawDump,
      tail: 20,
    });
    expect(readFileSync(rawDump, "utf8").split("\x1b[2J\x1b[3J\x1b[H").length - 1).toBe(0);
  }, 90_000);

  test("rows = 12 with a long session list: banner, actionable row and hint survive", async () => {
    const meta = await runPtyRaw({
      cols: 80,
      rows: 12,
      config: DEV_CONFIG,
      project: { provider: "mock" },
      seedSessions: 12,
      steps: [{ wait: 4.0, until: "New session" }],
      tail: 14,
    });
    const text = meta.lines.map((line) => line.text).join("\n");
    expect(text).toContain("My Own Harness");
    expect(text).toContain("New session");
    expect(text).toContain("ctrl+o mode"); // the footer hint survives
    // Seeded titles exist (session rows / more-indicator), not a blank screen.
    expect(text.length).toBeGreaterThan(50);
  }, 90_000);

  test("rows = 14: arrows, enter and esc still work in the compact layout", async () => {
    const meta = await runPtyRaw({
      cols: 80,
      rows: 14,
      config: DEV_CONFIG,
      project: { provider: "mock" },
      seedSessions: 3,
      steps: [
        { wait: 4.0, until: "New session" },
        { send: Buffer.from("\x1b[B").toString("base64") }, // ↓ onto a session row
        { wait: 0.5 },
        { send: Buffer.from("x").toString("base64") }, // type into the search query…
        { wait: 0.5 },
        { send: Buffer.from("\x1b").toString("base64") }, // …esc clears it, Home stays usable
        { wait: 0.5 },
        { send: Buffer.from("\x1b[B").toString("base64") }, // ↓ again, navigation intact
        { wait: 0.5 },
        { send: Buffer.from("\r").toString("base64") }, // enter opens the selection
        { wait: 2.0, until: "esc" },
      ],
      tail: 16,
    });
    const text = meta.lines.map((line) => line.text).join("\n");
    // The chat took over from Home: navigation (arrows/enter/esc) opened a session.
    expect(text).not.toContain("New session");
  }, 90_000);
});
