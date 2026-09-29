import { expect, test } from "bun:test";
import { hasPython, runPty } from "./pty-runner";
import { COMPOSER_READY } from "../helpers";

/**
 * The only layout assertion that still needs a real process/terminal is
 * SIGWINCH: the child receives a kernel resize signal and Ink must repaint
 * its live frame in the new geometry while native scrollback remains native.
 * Settings widths, command-panel windowing and compact Home geometry are
 * level-1 claims covered by viewport/frame/app tests.
 */
test.skipIf(!hasPython)("SIGWINCH reflows the live frame without widening post-resize rows", async () => {
  const B = (s: string) => btoa(s);
  const lines = await runPty({
    cols: 120,
    rows: 35,
    config: { onboarded: true, workflowOffered: true, mode: "dev" },
    steps: [
      { wait: 8.0, until: "New session", untilOnScreen: true },
      { wait: 0.3, send: B("resize probe") },
      { wait: 0.2, send: B("\r") },
    ],
    resize: { cols: 80, rows: 24, until: COMPOSER_READY, untilWait: 10.0 },
    tail: 24,
  });
  const inputIdx = lines.reduce<number>((acc, line, index) => (
    line.text.includes(COMPOSER_READY) ? index : acc
  ), -1);
  expect(inputIdx).toBeGreaterThanOrEqual(0);
  const input = lines[inputIdx]!;
  expect(input.lead).toBeLessThanOrEqual(2);
  expect(input.width).toBeLessThanOrEqual(80);
  for (const line of lines.slice(inputIdx)) expect(line.width).toBeLessThanOrEqual(80);
  expect(lines.slice(inputIdx).some((line) => line.text.includes("model"))).toBe(true);
}, 30_000);
