import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPty, runPtyRaw } from "./pty-runner";

const encodeBase64 = (s: string) => btoa(s);

/**
 * Exact owner symptom (#201 candidate): while a response is still streaming,
 * text which has already arrived must remain on the terminal screen. A
 * paragraph boundary makes the first block eligible for Static promotion;
 * the delayed second delta keeps the turn open when the PTY snapshot lands.
 */
function startSlowStream(withTool = false): { server: ReturnType<typeof Bun.serve>; url: string } {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      const encoder = new TextEncoder();
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        encoder.encode(`data: ${JSON.stringify({
          id: "streaming-persistence",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(chunk({ role: "assistant" }));
          if (withTool && calls === 1) {
            controller.enqueue(chunk({ tool_calls: [{ index: 0, id: "glob-1", type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "*.md" }) } }] }));
            controller.enqueue(chunk({}, "tool_calls"));
          } else {
            controller.enqueue(chunk({ content: withTool ? "AFTER-TOOL-STREAMING-TAIL" : "FIRST-PARAGRAPH\n\n" }));
            await Bun.sleep(350);
            controller.enqueue(chunk({ content: withTool ? "" : "SECOND-STREAMING-TAIL" }));
            await Bun.sleep(3_000);
            controller.enqueue(chunk({}, "stop"));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/v1` };
}

describe.skipIf(!hasPython)("streaming blocks persist on screen", () => {
  test("a promoted paragraph remains visible while the following tail streams", async () => {
    const { server, url } = startSlowStream();
    try {
      const lines = await runPty({
        cols: 120,
        rows: 40,
        config: {
          onboarded: true,
          workflowOffered: true,
          mode: "dev",
          provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        steps: [
          { wait: 1.0 },
          { wait: 0.2, send: encodeBase64("stream") },
          { wait: 0.2, send: encodeBase64("\r") },
          // First paragraph is closed; the second delta is present; finish is delayed.
          { wait: 1.0 },
        ],
        tail: 40,
      });
      const frame = lines.map((line) => line.text).join("\n");
      expect(frame).toContain("FIRST-PARAGRAPH");
      expect(frame).toContain("SECOND-STREAMING-TAIL");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("a completed action remains visible while the next model call streams", async () => {
    const { server, url } = startSlowStream(true);
    try {
      const lines = await runPty({
        cols: 120,
        rows: 40,
        config: {
          onboarded: true, workflowOffered: true, mode: "dev", provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        steps: [{ wait: 1.0 }, { wait: 0.2, send: encodeBase64("stream action") }, { wait: 0.2, send: encodeBase64("\r") }, { wait: 1.0 }],
        tail: 40,
      });
      const frame = lines.map((line) => line.text).join("\n");
      expect(frame).toContain("✓ glob");
      expect(frame).toContain("AFTER-TOOL-STREAMING-TAIL");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("an unbroken oversized prose stream stays output-bounded (#203)", async () => {
    const { server, url } = startUnbrokenStream();
    const rawDump = "/tmp/moh-streaming-tail-raw.bin";
    try {
      const meta = await runPtyRaw({
        cols: 120,
        rows: 40,
        config: {
          onboarded: true, workflowOffered: true, mode: "dev", provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        steps: [{ wait: 1.0 }, { wait: 0.2, send: encodeBase64("long stream") }, { wait: 0.2, send: encodeBase64("\r") }, { wait: 2.5 }],
        tail: 40,
        rawDump,
      });
      expect(meta.lines.map((line) => line.text).join("\n")).toContain("TAIL-119");
      // Without the single-block clip, Ink rewrites every accumulated row
      // for each of the 120 chunks (quadratic raw output).
      expect(readFileSync(rawDump).byteLength).toBeLessThan(1_500_000);
    } finally {
      server.stop(true);
    }
  }, 15_000);
});

function startUnbrokenStream(): { server: ReturnType<typeof Bun.serve>; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finishReason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "unbroken", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`));
          send({ role: "assistant" });
          for (let i = 0; i < 120; i++) {
            send({ content: `${"x".repeat(120)} TAIL-${i} ` });
            await Bun.sleep(10);
          }
          send({}, "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/v1` };
}
