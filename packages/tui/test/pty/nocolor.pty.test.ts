/**
 * #880: `NO_COLOR` in a **real terminal** — the acceptance criterion no
 * component test can carry, because Ink only paints color when chalk believes
 * it is on a TTY.
 *
 * Two runs of the same session, one variable apart, compared on the raw PTY
 * byte stream: with `NO_COLOR` set, no color SGR reaches the wire (`38;…`
 * foreground, `48;…` background) while the attribute codes still do
 * (`1m` bold, `2m` dim) — the convention is about color, not emphasis. The
 * control run proves the assertion is not vacuous: without the variable the
 * very same screen is painted in color.
 *
 * The turn is served by a local endpoint that answers slowly, so the run
 * covers the live window too: that is where the liveness scanner's bold light
 * and dim trail live (ADR-0042), and a color-free terminal must still show
 * them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPtyRaw } from "./pty-runner";

/**
 * Every way a color can reach the terminal: truecolor (38/48), the 16-color
 * range (30-37 fg / 40-47 bg / 90-97 bright fg / 100-107 bright bg) and the
 * 256-color index (38;5 / 48;5). The 16-color forms matter: cli-highlight's
 * own fallback theme paints with them, and a regex that only knew truecolor
 * would call that run color-free (the leak #880's review caught).
 */
const COLOR = /\x1b\[(3[0-7]|4[0-7]|9[0-7]|10[0-7]|38;|48;)/g;
const BOLD = /\x1b\[1m/g;
const DIM = /\x1b\[2m/g;
const B = (s: string) => btoa(s);
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;
const raw = (path: string) => readFileSync(path).toString("latin1");

/** A one-answer endpoint whose reply lands after ~1.5s, holding the turn open
 * long enough for the pending footer (scanner included) to be painted. */
function startSlowEndpoint(): { server: ReturnType<typeof Bun.serve>; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        encoder.encode(`data: ${JSON.stringify({ id: "nocolor", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(chunk({ role: "assistant" }));
          controller.enqueue(chunk({ content: "Hello from moh" }));
          await Bun.sleep(1500);
          controller.enqueue(chunk({}, "stop"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/v1` };
}

const scenario = (env: Record<string, string>, url: string, rawPath: string) => ({
  cols: 100,
  rows: 30,
  config: {
    onboarded: true,
    workflowOffered: true,
    mode: "dev",
    provider: "fake",
    endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
  },
  env,
  steps: [
    { wait: 4.0, until: "type…" },
    { wait: 0.3, send: B("hi") },
    { wait: 0.4, send: B("\r") },
    { wait: 6.0, until: "Hello from moh" },
  ],
  tail: 30,
  rawDump: rawPath,
});

describe.skipIf(!hasPython)("NO_COLOR in a real PTY (#880)", () => {
  test("set: no color code on the wire, emphasis kept", async () => {
    const { server, url } = startSlowEndpoint();
    try {
      await runPtyRaw(scenario({ NO_COLOR: "1" }, url, "/tmp/moh-nocolor-on.bin"));
    } finally {
      server.stop(true);
    }
    const bytes = raw("/tmp/moh-nocolor-on.bin");
    expect(count(bytes, COLOR)).toBe(0);
    // Emphasis is not color: the scanner's light stays bold and its trail
    // stays dim (ADR-0042), so a color-free terminal keeps the beat readable.
    expect(count(bytes, BOLD)).toBeGreaterThan(0);
    expect(count(bytes, DIM)).toBeGreaterThan(0);
    // The session really rendered: the assertions above are not passing on an
    // empty screen.
    expect(bytes).toContain("Hello from moh");
  }, 60_000);

  test("unset: the same screen is painted in color (the control)", async () => {
    const { server, url } = startSlowEndpoint();
    try {
      await runPtyRaw(scenario({}, url, "/tmp/moh-nocolor-off.bin"));
    } finally {
      server.stop(true);
    }
    const bytes = raw("/tmp/moh-nocolor-off.bin");
    expect(count(bytes, COLOR)).toBeGreaterThan(0);
    expect(bytes).toContain("Hello from moh");
  }, 60_000);
});
