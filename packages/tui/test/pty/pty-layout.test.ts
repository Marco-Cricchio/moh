import { expect, test } from "bun:test";
import { hasPython, runPty, runPtyRaw } from "./pty-runner";
import { startFakeOpenAiTurns } from "./fake-openai-turns";
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

test.skipIf(!hasPython)("#1305 settled tinted cards never send the live frame fullscreen", async () => {
  const { server, url } = startFakeOpenAiTurns(3);
  const B = (s: string) => btoa(s);
  try {
    const meta = await runPtyRaw({
      cols: 100, rows: 30,
      config: {
        onboarded: true, workflowOffered: true, mode: "dev", provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
      },
      steps: [
        { wait: 8, until: "New session", untilOnScreen: true },
        { mark: true },
        ...[1, 2, 3].flatMap((turn) => [
          { wait: 0.3, send: B(`surface ${turn}`) },
          { wait: 0.3, send: B("\r") },
          { wait: 10, until: `TURN-${turn}-MARKER`, untilOnScreen: true },
          { wait: 10, until: COMPOSER_READY, untilOnScreen: true },
        ]),
        { markEnd: true },
      ],
      tail: 30,
    });
    expect(meta.framesAfterMark).toBeGreaterThan(0);
    expect(meta.fullscreenAfterMark).toBe(0);
    // Static card rows can share a synchronized write with the live frame;
    // record that combined span without mistaking it for volatile height.
    console.log(`[block-surfaces PTY] maxFrameRows=${meta.maxFrameRows} maxFrameRowsAfterMark=${meta.maxFrameRowsAfterMark} fullscreenFrames=${meta.fullscreenFrames}`);
    expect(meta.aliveAtEnd).toBe(true);
  } finally { server.stop(true); }
}, 45_000);
