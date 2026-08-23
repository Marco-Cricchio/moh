import { describe, expect, test } from "bun:test";
import { hasPython, runPty } from "./pty-runner";

/**
 * Chat window verification in a real PTY (issue #117 acceptance criteria):
 * the transcript is a fixed-height internal window — keyboard scroll moves
 * the offset (follow-tail pauses scrolled up, resumes at the bottom), and
 * streaming/turn activity below a scrolled-up view never yanks it back to
 * the tail. Resize reflows without breaking the bottom anchor.
 */

const B = (s: string) => btoa(s);

// Standard preamble: skip onboarding, skip the workflow offer → home.
const PREAMBLE = [
  { wait: 1.0, send: B("s") },
  { wait: 1.0, send: B("n") },
];
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";

/** Sends `msg` as one chat turn. */
const say = (msg: string, wait = 1.6) => [
  { wait: 0.3, send: B(msg) },
  { wait: 0.2, send: B("\r") },
  { wait },
];

const text = (lines: readonly { text: string }[]) => lines.map((l) => l.text).join("\n");

describe.skipIf(!hasPython)("PTY chat window (issue #117)", () => {
  test(
    "scroll offset: pageUp reveals older turns, the tail leaves; pageDown resumes follow-tail",
    async () => {
      const lines = await runPty({
        cols: 100,
        rows: 30,
        steps: [
          ...PREAMBLE,
          { wait: 0.5 },
          ...say("marker-m1"),
          ...say("marker-m2"),
          ...say("marker-m3"),
          ...say("marker-m4"),
          { wait: 0.5, send: B(PGUP) },
          { wait: 0.5, send: B(PGUP) },
          { wait: 0.8 },
        ],
        tail: 30,
      });
      const screen = text(lines);
      // scrolled up: the oldest marker is back, the newest left the window
      expect(screen).toContain("marker-m1");
      expect(screen).not.toContain("marker-m4");
      // the frame never exceeds the terminal
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(100);
      expect(lines.length).toBeLessThanOrEqual(30);
    },
    45000,
  );

  test(
    "streaming during scroll: a new turn below a scrolled-up view does not move it; pageDown resumes the tail",
    async () => {
      const scrolled = await runPty({
        cols: 100,
        rows: 30,
        steps: [
          ...PREAMBLE,
          { wait: 0.5 },
          ...say("stable-m1"),
          ...say("stable-m2"),
          ...say("stable-m3"),
          ...say("stable-m4"),
          { wait: 0.5, send: B(PGUP) },
          { wait: 0.5, send: B(PGUP) },
          { wait: 0.5 },
          ...say("stable-m5", 2.0), // arrives while scrolled up
          { wait: 0.5 },
        ],
        tail: 30,
      });
      const held = text(scrolled);
      // the view held: still the old window, the new turn did not yank it down
      expect(held).toContain("stable-m1");
      expect(held).not.toContain("stable-m5");

      const resumed = await runPty({
        cols: 100,
        rows: 30,
        steps: [
          ...PREAMBLE,
          { wait: 0.5 },
          ...say("stable-m1"),
          ...say("stable-m2"),
          ...say("stable-m3"),
          ...say("stable-m4"),
          { wait: 0.5, send: B(PGUP) },
          { wait: 0.5, send: B(PGUP) },
          { wait: 0.5 },
          ...say("stable-m5", 2.0),
          { wait: 0.3, send: B(PGDN) },
          { wait: 0.3, send: B(PGDN) },
          { wait: 0.3, send: B(PGDN) },
          { wait: 0.8 },
        ],
        tail: 30,
      });
      const tail = text(resumed);
      expect(tail).toContain("stable-m5");
      expect(tail).not.toContain("stable-m1");
    },
    90000,
  );

  test(
    "resize reflows the window without breaking the bottom anchor",
    async () => {
      const lines = await runPty({
        cols: 100,
        rows: 30,
        steps: [
          ...PREAMBLE,
          { wait: 0.5 },
          ...say("anchor-m1"),
          ...say("anchor-m2"),
          ...say("anchor-m3"),
          ...say("anchor-m4"),
          { wait: 1.0 },
        ],
        resize: { cols: 130, rows: 40 },
        tail: 40,
      });
      const screen = text(lines);
      // taller window, still bottom-anchored: the newest turn visible
      expect(screen).toContain("anchor-m4");
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(130);
      expect(lines.length).toBeLessThanOrEqual(40);
    },
    45000,
  );
});
