/**
 * Image mention preview in a real PTY (#490, vision note 4): with the
 * environment pinned to iTerm2/kitty, sending `@image.png` must attach
 * the image AND emit actual pixel escape sequences on the raw PTY
 * stream — regression coverage for the owner's iTerm2 report.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPtyRaw, DEV_CONFIG, type PtySpec } from "./pty-runner";
import { startFakeOpenAi } from "./fake-openai";

/** 1x1 red png (smallest valid base64 image the assembly accepts). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Keystrokes are only read once the Home screen has settled (the logo intro
 * and the first frame are still mounting before that, and a send written then
 * loses its Enter). Under load the first frame lands seconds later, so a fixed
 * `wait` before the first send is not a readiness signal (#1483: the send
 * landed at t≈3.5s, the home settled at ≈7.5s, the prompt was typed but never
 * submitted, and the wait expired at 30s).
 *
 * The step after the submit waits for the pixel escape itself, which the
 * attach emits before any model work. The fixture's 15-call chain and four
 * ask_user gates ran in ≈15s on a quiet host and ≈25s with four PTY batches
 * in parallel, so waiting for their "Q1" gate spent the 30s budget on the
 * model fixture rather than on the attach under test.
 */
function scenario(env: Record<string, string>, pixelNeedle: string): PtySpec {
  return {
    cols: 100,
    rows: 30,
    env,
    config: { ...DEV_CONFIG, images: { preview: "auto" }, provider: "fake", endpoints: [{ name: "fake", type: "openai-compat", baseUrl: "", apiKey: "test-key", defaultModel: "fake-model" }] },
    project: { permissions: { overrides: { tools: { bash: "allow" } } } },
    files: { "image.png": PNG.toString("base64") },
    steps: [
      { until: "no sessions yet", wait: 30.0, untilFromBuffer: true },
      { send: btoa("look @image.png"), wait: 0.3 },
      { send: btoa("\r"), wait: 1.0 },
      { until: pixelNeedle, wait: 30.0, untilFromBuffer: true },
      { wait: 1.0 },
    ],
    tail: 30,
  };
}

describe.skipIf(!hasPython)("image mention preview PTY (#490)", () => {
  test("iTerm2 env: @mention attaches and emits an OSC 1337 sequence", async () => {
    const { server, url } = startFakeOpenAi();
    const spec = scenario({ TERM_PROGRAM: "iTerm.app" }, "\x1b]1337;File=");
    (spec.config as Record<string, unknown>).endpoints = [
      { name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" },
    ];
    const { lines } = await runPtyRaw({ ...spec, rawDump: "/tmp/moh-img-i-raw.bin" });
    server.stop(true);
    // The mention row rendered (with the @, owner's symptom).
    expect(lines.map((l) => l.text).join("\n")).not.toContain("not found");
    // Pixels: the iTerm2 OSC 1337 inline file on the raw stream.
    const raw = readFileSync("/tmp/moh-img-i-raw.bin").toString("latin1");
    expect(raw).toContain("\x1b]1337;File=");
  }, 60_000);

  test("kitty env: the graphics protocol hits the raw stream", async () => {
    const { server, url } = startFakeOpenAi();
    const spec = scenario({ KITTY_WINDOW_ID: "1" }, "\x1b_Gf=1,a=T,");
    (spec.config as Record<string, unknown>).endpoints = [
      { name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" },
    ];
    await runPtyRaw({ ...spec, rawDump: "/tmp/moh-img-k-raw.bin" });
    server.stop(true);
    const raw = readFileSync("/tmp/moh-img-k-raw.bin").toString("latin1");
    expect(raw).toContain("\x1b_Gf=1,a=T,");
  }, 60_000);
});
