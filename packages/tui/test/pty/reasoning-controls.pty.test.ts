import { describe, expect, test } from "bun:test";
import { hasPython, runPty, DEV_CONFIG } from "./pty-runner";

const encodeBase64 = (text: string) => btoa(text);

/** #242: real-terminal coverage for the non-blocking controls and narrow
 * status geometry. Provider reasoning content itself is covered by focused
 * Ink projection tests; the PTY guards native-scrollback/chrome behavior. */
describe.skipIf(!hasPython)("reasoning controls PTY (#242)", () => {
  test("/thinking show applies as non-blocking chrome without width overflow", async () => {
    const lines = await runPty({
      cols: 64,
      rows: 24,
      config: { ...DEV_CONFIG, provider: "mock", showReasoning: false },
      steps: [
        { wait: 1.0 },
        { send: encodeBase64("hello"), wait: 0.2 },
        { send: encodeBase64("\r"), wait: 0.5 },
        { until: "mock provider", wait: 0.5 },
        { send: encodeBase64("/thinking show"), wait: 0.2 },
        { send: encodeBase64("\r"), wait: 0.4 },
        { until: "reasoning display on", wait: 0.4 },
      ],
      tail: 24,
    });
    const frame = lines.map((line) => line.text).join("\n");
    expect(frame).toContain("reasoning display"); // narrow status intentionally clips the tail
    expect(lines.every((line) => line.lead + line.width <= 64)).toBe(true);
    // The command is non-blocking: the input remains available.
    expect(frame).toContain("type…");
  }, 15_000);

  test("bottom-bar ctrl+y explains models with no level map", async () => {
    const lines = await runPty({
      cols: 100,
      rows: 24,
      config: { ...DEV_CONFIG, provider: "mock" },
      steps: [
        { wait: 1.0 },
        { send: encodeBase64("hello"), wait: 0.2 },
        { send: encodeBase64("\r"), wait: 0.5 },
        { until: "mock provider", wait: 0.5 },
        { send: encodeBase64("\u0019"), wait: 0.4 }, // ctrl+y
        { until: "thinking levels not offered for mock", wait: 0.4 },
      ],
      tail: 24,
    });
    const frame = lines.map((line) => line.text).join("\n");
    expect(frame).toContain("thinking levels not offered fo"); // width-capped status projection
    const status = lines.find((line) => line.text.includes("thinking levels not offered"));
    expect(status && status.lead + status.width <= 100).toBe(true);
  }, 15_000);
});
