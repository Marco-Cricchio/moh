import { describe, expect, test } from "bun:test";
import { hasPython, runPty } from "./pty-runner";

/**
 * Layout verification in a real PTY (issues #64/#65 acceptance criteria).
 * Headless Ink renders cannot validate viewport geometry, cursor
 * windowing or resize behavior — these tests drive the actual CLI inside
 * a pseudo terminal (see harness.py) at multiple sizes, including one
 * compact size, covering home, chat, settings navigation and panel
 * scrolling, plus a mid-session resize.
 */

const B = (s: string) => btoa(s);
const DOWN = B("\x1b[B");

// Standard preamble: skip onboarding, skip the workflow offer → home.
// Generous waits: a keystroke that lands after a screen transition can
// hit the wrong handler (e.g. "s" on home opens settings).
const PREAMBLE = [
  { wait: 1.0, send: B("s") },
  { wait: 1.0, send: B("n") },
];

describe.skipIf(!hasPython)("PTY layout (issues #64/#65)", () => {
  test(
    "wide terminal: session is a frameless full-width scrollback column (#183)",
    async () => {
      const lines = await runPty({
        cols: 160,
        rows: 45,
        steps: [...PREAMBLE, { wait: 0.5 }, { wait: 0.3, send: B("hello") }, { wait: 0.2, send: B("\r") }, { wait: 2.0 }],
        tail: 45,
      });
      const input = lines.find((l) => l.text.includes("type…"));
      expect(input).toBeDefined();
      const gutter = input!.text.indexOf("›");
      expect(gutter).toBeLessThanOrEqual(3);
      expect(lines.some((l) => l.text.includes("Wayfinder"))).toBe(false);
      expect(lines.some((l) => l.text.includes("model"))).toBe(true);
      expect(lines.some((l) => l.text.trim() === "› you")).toBe(true);
      const transcriptRows = lines.filter((l) => l.text.includes("hello") || l.text.includes("› you") || l.text.includes("◆ moh"));
      for (const row of transcriptRows) expect(row.text).not.toMatch(/[┌┐└┘╭╮╰╯]/);
      // Nothing ever paints past the terminal edge.
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(160);
    },
    30000,
  );

  test(
    "wide terminal: settings floats transparently without moving the live chat",
    async () => {
      const enterChat = [...PREAMBLE, { wait: 0.5, send: B("n") }, { wait: 0.8 }];
      const baseline = await runPty({ cols: 160, rows: 45, steps: enterChat, tail: 45 });
      const lines = await runPty({
        cols: 160,
        rows: 45,
        steps: [...enterChat, { wait: 0.8, send: B("\x13") }],
        tail: 45,
      });
      const inputRow = (screen: typeof lines) => screen.findIndex((l) => l.text.includes("type…"));
      const chipsRow = (screen: typeof lines) => screen.findIndex((l) => l.text.includes("⏎ send"));
      expect(inputRow(baseline)).toBeGreaterThanOrEqual(0);
      expect(chipsRow(baseline)).toBeGreaterThanOrEqual(0);
      expect(inputRow(lines)).toBe(inputRow(baseline));
      expect(chipsRow(lines)).toBe(chipsRow(baseline));
      const title = lines.find((l) => l.text.includes("settings"));
      expect(title).toBeDefined();
      // Horizontally: ~62% of 160 (99±2), with transparent chat on both sides.
      const border = lines.find((l) => l.text.indexOf("╭") >= 28);
      expect(border).toBeDefined();
      const dialogStart = border!.text.indexOf("╭");
      expect(border!.width - dialogStart).toBeGreaterThanOrEqual(97);
      expect(border!.width - dialogStart).toBeLessThanOrEqual(101);
    },
    30000,
  );

  test(
    "short terminal: settings cursor stays visible at the bottom, no bleed",
    async () => {
      const lines = await runPty({
        cols: 80,
        rows: 20,
        steps: [...PREAMBLE, { wait: 0.5 }, { wait: 0.8, send: B("\x13") }, { wait: 0.6, send: DOWN.repeat(9) }],
        tail: 20,
      });
      expect(lines.some((l) => l.text.includes("Remove provider"))).toBe(true);
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(80);
    },
    30000,
  );

  test(
    "compact width: settings dialog goes full width, rows never split",
    async () => {
      const lines = await runPty({
        cols: 50,
        rows: 20,
        steps: [...PREAMBLE, { wait: 0.5 }, { wait: 0.8, send: B("\x13") }, { wait: 0.6, send: DOWN.repeat(9) }],
        tail: 20,
      });
      const top = lines.find((l) => l.text.includes("╭"));
      expect(top).toBeDefined();
      expect(top!.width - top!.lead).toBeGreaterThanOrEqual(46);
      expect(lines.some((l) => /Default permission mode\s+normal/.test(l.text))).toBe(true);
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(50);
    },
    30000,
  );

  test(
    "short terminal: commands panel scrolls, every group reachable",
    async () => {
      const lines = await runPty({
        cols: 80,
        rows: 18,
        steps: [...PREAMBLE, { wait: 0.5 }, { wait: 0.8, send: B("?") }, { wait: 0.8, send: DOWN.repeat(30) }],
        tail: 18,
      });
      expect(lines.some((l) => l.text.includes("Modals"))).toBe(true);
      expect(lines.some((l) => l.text.includes("↑ "))).toBe(true);
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(80);
    },
    30000,
  );

  test(
    "resize mid-session: live input and bottom bar reflow; printed scrollback remains native (#183)",
    async () => {
      const lines = await runPty({
        cols: 120,
        rows: 35,
        steps: [...PREAMBLE, { wait: 0.5 }, { wait: 0.3, send: B("resize probe") }, { wait: 0.2, send: B("\r") }, { wait: 1.5 }],
        resize: { cols: 80, rows: 24 },
        tail: 24,
      });
      // The cumulative pty buffer still contains pre-resize frames:
      // assert on the final frame only (from the last input line on).
      const inputIdx = lines.reduce<number>((acc, l, i) => (l.text.includes("type…") ? i : acc), -1);
      expect(inputIdx).toBeGreaterThanOrEqual(0);
      const input = lines[inputIdx]!;
      expect(input.lead).toBeLessThanOrEqual(2);
      expect(input.width).toBeLessThanOrEqual(80);
      // Static rows keep their original width in terminal history; only the
      // post-resize live area must fit the new terminal.
      for (const l of lines.slice(inputIdx)) expect(l.width).toBeLessThanOrEqual(80);
      expect(lines.slice(inputIdx).some((l) => l.text.includes("model"))).toBe(true);
    },
    30000,
  );
});
