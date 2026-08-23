import { describe, expect, test } from "bun:test";
import { DEV_CONFIG, VIBE_CONFIG, hasPython, runPty } from "./pty-runner";

/**
 * Dashboard shell verification in a real PTY (issue #115 acceptance
 * criteria, right sidebar per #118): at ≥90 columns the session screen
 * renders the dashboard frame with aligned panel borders inside the
 * terminal budget; below 90 it is the unchanged single-column chat; the
 * switch reacts live to resize.
 */

const B = (s: string) => btoa(s);

// Settings pinned via the injected config: no overlay preamble needed.
const enterChat = (config: Record<string, unknown>) => ({
  config,
  steps: [
    { wait: 1.5 },
    { wait: 0.3, send: B("hello") },
    { wait: 0.2, send: B("\r") },
    { wait: 2.0 },
  ],
});

// Standard preamble: skip onboarding, skip the workflow offer → home.
const PREAMBLE = [
  { wait: 1.0, send: B("s") },
  { wait: 1.0, send: B("n") },
];
// Open a new session from home with an initial prompt (default settings).
const ENTER_CHAT = [
  ...PREAMBLE,
  { wait: 0.5 },
  { wait: 0.3, send: B("hello") },
  { wait: 0.2, send: B("\r") },
  { wait: 2.0 },
];

/** Rows (1-based) whose text contains the marker, ignoring ANSI. */
const rowsWith = (lines: readonly { text: string }[], marker: string) =>
  lines.map((l, i) => (l.text.includes(marker) ? i + 1 : 0)).filter((n) => n > 0);

describe.skipIf(!hasPython)("PTY dashboard shell (issue #115)", () => {
  test(
    "dev mode at 100 cols: menu + right sidebar (Activity/Workflow/Tokens) + aligned borders within budget",
    async () => {
      const lines = await runPty({ cols: 100, rows: 30, tail: 30, ...enterChat(DEV_CONFIG) });
      // The frame: menu entries, right sidebar sections, chip row.
      expect(lines.some((l) => l.text.includes("Wayfinder"))).toBe(true);
      expect(lines.some((l) => l.text.includes("Activity"))).toBe(true);
      expect(lines.some((l) => l.text.includes("Workflow"))).toBe(true);
      expect(lines.some((l) => l.text.includes("Tokens"))).toBe(true);
      expect(lines.some((l) => l.text.includes("( ⏎ send )"))).toBe(true);
      expect(lines.some((l) => l.text.includes("type…"))).toBe(true);
      // Panel bottom borders aligned: the menu and right-sidebar ╰ corners
      // land on the same row (two corners on one line — the chat input's
      // own ╰ sits higher inside the center column).
      const bottoms = rowsWith(lines, "╰");
      expect(bottoms.length).toBeGreaterThanOrEqual(2);
      const last = bottoms[bottoms.length - 1]!;
      const corners = lines[last - 1]!.text.split("╰").length - 1;
      expect(corners).toBeGreaterThanOrEqual(2);
      // Budget: nothing paints past the terminal edge, chips sit on the last row.
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(100);
      expect(lines.length).toBeLessThanOrEqual(30);
    },
    30000,
  );

  test(
    "vibe mode (default): right sidebar hidden, dashboard otherwise identical",
    async () => {
      const lines = await runPty({ cols: 100, rows: 30, tail: 30, ...enterChat(VIBE_CONFIG) });
      expect(lines.some((l) => l.text.includes("Wayfinder"))).toBe(true);
      expect(lines.some((l) => l.text.includes("type…"))).toBe(true);
      // No right-sidebar sections in vibe (spec D6).
      expect(lines.some((l) => l.text.includes("Activity"))).toBe(false);
      expect(lines.some((l) => l.text.includes("Tokens"))).toBe(false);
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(100);
      expect(lines.length).toBeLessThanOrEqual(30);
    },
    30000,
  );

  test(
    "border alignment and budget hold at several sizes",
    async () => {
      for (const [cols, rows] of [[90, 24], [120, 40], [160, 50]] as const) {
        const lines = await runPty({ cols, rows, tail: rows, ...enterChat(DEV_CONFIG) });
        expect(lines.some((l) => l.text.includes("Dashboard"))).toBe(true);
        for (const l of lines) expect(l.width).toBeLessThanOrEqual(cols);
        expect(lines.length).toBeLessThanOrEqual(rows);
      }
    },
    60000,
  );

  test(
    "below 90 cols the session screen stays single-column, live on resize",
    async () => {
      const lines = await runPty({
        cols: 80,
        rows: 24,
        steps: ENTER_CHAT,
        tail: 24,
      });
      expect(lines.some((l) => l.text.includes("Wayfinder"))).toBe(false);
      expect(lines.some((l) => l.text.includes("type…"))).toBe(true);
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(80);
    },
    30000,
  );

  test(
    "SIGWINCH: dashboard appears on grow and disappears on shrink",
    async () => {
      const grown = await runPty({
        cols: 80,
        rows: 24,
        steps: [...ENTER_CHAT, { wait: 1.0 }],
        resize: { cols: 110, rows: 24 },
        tail: 24,
      });
      expect(grown.some((l) => l.text.includes("Wayfinder"))).toBe(true);
      const shrunk = await runPty({
        cols: 110,
        rows: 24,
        steps: ENTER_CHAT,
        resize: { cols: 80, rows: 24 },
        tail: 24,
      });
      expect(shrunk.some((l) => l.text.includes("Wayfinder"))).toBe(false);
    },
    60000,
  );
});
