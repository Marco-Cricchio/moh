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
          // Readiness wait (#236): assert only once the second paragraph's
          // tail has actually been streamed — fixed 1s cut it on slow hosts.
          { wait: 4.0, until: "SECOND-STREAMING-TAIL" },
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
        steps: [{ wait: 1.0 }, { wait: 0.2, send: encodeBase64("stream action") }, { wait: 0.2, send: encodeBase64("\r") }, { wait: 4.0, until: "AFTER-TOOL-STREAMING-TAIL" }],
        tail: 40,
      });
      const frame = lines.map((line) => line.text).join("\n");
      expect(frame).toContain("✓ glob");
      expect(frame).toContain("AFTER-TOOL-STREAMING-TAIL");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("a long unbroken reasoning paragraph grows scrollback before reasoning_end", async () => {
    const { server, url } = startLongReasoningStream();
    const rawDump = "/tmp/moh-streaming-long-reasoning-raw.bin";
    try {
      const meta = await runPtyRaw({
        cols: 120,
        rows: 24,
        config: {
          onboarded: true, workflowOffered: true, mode: "dev", provider: "fake", showReasoning: true,
          endpoints: [{
            name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model",
            capabilities: { thinking: { format: "openai-effort", levels: ["low"] } },
          }],
        },
        steps: [
          { wait: 1.0 },
          { wait: 0.2, send: encodeBase64("long reasoning") },
          { wait: 0.2, send: encodeBase64("\r") },
          { wait: 8.0, until: "LAST-LIVE-REASONING" },
          { wait: 0.4 },
        ],
        tail: 24,
        rawDump,
      });
      expect(meta.aliveAtEnd).toBe(true);
      const raw = readFileSync(rawDump, "utf8");
      expect(raw).not.toContain("REASONING-ENDED");
      expect(meta.scrollback?.some((line) => line.includes("FIRST-LIVE-REASONING"))).toBe(true);
      // It may repaint while still inside the five-row safety tail, but once
      // promoted it must disappear from the later majority of raw frames.
      expect(raw.slice(Math.floor(raw.length / 2))).not.toContain("FIRST-LIVE-REASONING");
      expect(readFileSync(rawDump).byteLength).toBeLessThan(750_000);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("visible reasoning, a tool, and a long Markdown reply grow scrollback before done", async () => {
    const { server, url } = startRealisticReasoningStream();
    const rawDump = "/tmp/moh-streaming-realistic-raw.bin";
    try {
      const meta = await runPtyRaw({
        cols: 120,
        rows: 24,
        config: {
          onboarded: true, workflowOffered: true, mode: "dev", provider: "fake", showReasoning: true,
          endpoints: [{
            name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model",
            capabilities: { thinking: { format: "openai-effort", levels: ["low"] } },
          }],
        },
        project: { permissions: { overrides: { tools: { glob: "allow" } } } },
        steps: [
          { wait: 1.0 },
          { wait: 0.2, send: encodeBase64("realistic stream") },
          { wait: 0.2, send: encodeBase64("\r") },
          { wait: 8.0, until: "LAST-MARKDOWN-SECTION" },
          { wait: 0.4 },
        ],
        tail: 24,
        rawDump,
      });
      expect(meta.aliveAtEnd).toBe(true);
      const raw = readFileSync(rawDump, "utf8");
      expect(raw).toContain("REALISTIC-REASONING");
      expect(raw).toContain("LAST-MARKDOWN-SECTION");
      expect(raw).not.toContain("REALISTIC-FINISHED");
      // #326 hold (owner report 2026-09-06): while the call's reasoning
      // group is not yet persisted, closed reply segments must NOT promote
      // below it — the printed order has to match the canonical one
      // (reasoning above reply) or ink's forward-only Static re-emits the
      // reordered items at done (the duplicated thinking/list blocks).
      // Every occurrence of the final call's reasoning (volatile repaints
      // included) must precede the reply's first painted section, and the
      // reasoning text must never duplicate: Static chunk + settled block
      // both carrying it is exactly the end-of-stream symptom.
      const composePositions = [...raw.matchAll(/REALISTIC-REASONING compose/g)].map((m) => m.index ?? 0);
      const firstSectionAt = raw.indexOf("FIRST-MARKDOWN-SECTION");
      expect(composePositions.length).toBe(1);
      expect(firstSectionAt).toBeGreaterThanOrEqual(0);
      expect(composePositions[0]!).toBeLessThan(firstSectionAt);
      // The reply stream stays bounded while held (no un-clipped block).
      expect(readFileSync(rawDump).byteLength).toBeLessThan(1_500_000);
      const history = meta.scrollback ?? [];
      const screen = meta.lines.map((line) => line.text);
      expect(screen.some((line) => line.includes("LAST-MARKDOWN-SECTION"))).toBe(true);
      expect([...history, ...screen].some((line) => line.includes("glob"))).toBe(true);
      const input = screen.findIndex((line) => line.includes("type…"));
      expect(input).toBeGreaterThanOrEqual(Math.floor(screen.length / 2));
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("completed lines enter terminal scrollback once while a long response is still streaming", async () => {
    const { server, url } = startLineStream();
    const rawDump = "/tmp/moh-streaming-lines-raw.bin";
    try {
      const meta = await runPtyRaw({
        cols: 120,
        rows: 20,
        config: {
          onboarded: true, workflowOffered: true, mode: "dev", provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        steps: [
          { wait: 1.0 },
          { wait: 0.2, send: encodeBase64("line stream") },
          { wait: 0.2, send: encodeBase64("\r") },
          // LAST-LIVE-LINE arrives before the provider sends finish_reason.
          { wait: 6.0, until: "LAST-LIVE-LINE" },
          // Let Ink finish the current frame under full-suite load. The fake
          // provider still holds the stream open for three seconds.
          { wait: 0.5 },
        ],
        tail: 20,
        rawDump,
      });
      expect(meta.aliveAtEnd).toBe(true);
      const raw = readFileSync(rawDump, "utf8");
      expect(raw).toContain("LAST-LIVE-LINE");
      expect(raw).not.toContain("STREAM-FINISHED");
      // A completed row belongs to native terminal scrollback. Repainting it
      // as part of the volatile viewport makes the response look like an
      // internally scrolling box and produces duplicate terminal output.
      expect(raw.match(/FIRST-COMPLETED-LINE/g)).toHaveLength(1);
      // Newline-heavy streams must remain bounded too; otherwise moving
      // rows into Static would fix the UX while recreating the old O(n²)
      // PTY flood through a different path.
      expect(readFileSync(rawDump).byteLength).toBeLessThan(500_000);
      const screen = meta.lines.map((line) => line.text);
      const input = screen.findIndex((line) => line.includes("type…"));
      expect(input).toBeGreaterThanOrEqual(Math.floor(meta.lines.length / 2));
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("final settlement does not reprint a prose prefix already in scrollback", async () => {
    const { server, url } = startLineStream();
    const rawDump = "/tmp/moh-streaming-lines-settled-raw.bin";
    try {
      await runPtyRaw({
        cols: 120,
        rows: 20,
        config: {
          onboarded: true, workflowOffered: true, mode: "dev", provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        steps: [
          { wait: 1.0 },
          { wait: 0.2, send: encodeBase64("settled line stream") },
          { wait: 0.2, send: encodeBase64("\r") },
          { wait: 7.0, until: "STREAM-FINISHED" },
          { wait: 0.5 },
        ],
        tail: 20,
        rawDump,
      });
      expect(readFileSync(rawDump, "utf8").match(/FIRST-COMPLETED-LINE/g)).toHaveLength(1);
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
        steps: [{ wait: 1.0 }, { wait: 0.2, send: encodeBase64("long stream") }, { wait: 0.2, send: encodeBase64("\r") }, { wait: 6.0, until: "TAIL-119" }],
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

function startLongReasoningStream(): { server: ReturnType<typeof Bun.serve>; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finishReason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "long-reasoning", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`));
          send({ role: "assistant" });
          const words = ["FIRST-LIVE-REASONING", ...Array.from({ length: 220 }, (_, i) => `thought-${i}`), "LAST-LIVE-REASONING"];
          for (const word of words) {
            send({ reasoning_content: `${word} ` });
            await Bun.sleep(8);
          }
          await Bun.sleep(3_000);
          send({ content: "REASONING-ENDED" });
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

function startRealisticReasoningStream(): { server: ReturnType<typeof Bun.serve>; url: string } {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finishReason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: `realistic-${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`));
          send({ role: "assistant" });
          if (calls === 1) {
            send({ reasoning_content: "REALISTIC-REASONING inspect the manual before answering" });
          } else {
            // GLM persists multiple reasoning parts per call (#240): the
            // fixture must exercise the coalesced-group seal, not a single
            // part, or the duplicated end-of-stream block stays untested.
            send({ reasoning_content: "REALISTIC-REASONING compose the final answer" });
            send({ reasoning_content: " after checking every tool result twice" });
          }
          if (calls === 1) {
            send({ tool_calls: [{ index: 0, id: "glob-realistic", type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "docs/manual/*.md" }) } }] });
            send({}, "tool_calls");
          } else {
            const sections = [
              "## FIRST-MARKDOWN-SECTION\n\nMoh starts with an open headless core and keeps its clients deliberately thin.",
              "\n\n## Architecture\n\n1. The event log is the session.\n2. Providers remain replaceable.\n3. Permissions only narrow access.",
              "\n\nPLAIN-PROSE-PARAGRAPH with no markdown syntax at all just ordinary words that keep flowing and wrapping across many terminal rows while the frozen thinking block waits for its persisted reasoning event to arrive in the log",
              "\n\n## Workflow\n\nProfessional developers get reviewable stages while vibe coders get safe rails without learning every internal detail.",
              "\n\n## LAST-MARKDOWN-SECTION\n\nThe final section is still streaming while the first one should already be in terminal scrollback. ",
            ];
            for (const section of sections) {
              for (const word of section.split(/(?<=\s)/)) {
                send({ content: word });
                await Bun.sleep(8);
              }
            }
            await Bun.sleep(3_000);
            send({ content: "REALISTIC-FINISHED" });
            send({}, "stop");
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

function startLineStream(): { server: ReturnType<typeof Bun.serve>; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finishReason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "line-stream", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`));
          send({ role: "assistant" });
          for (let i = 0; i < 24; i++) {
            const marker = i === 0 ? "FIRST-COMPLETED-LINE" : i === 23 ? "LAST-LIVE-LINE" : `MIDDLE-LINE-${i}`;
            send({ content: `${marker} ${"x".repeat(120)}\n` });
            await Bun.sleep(20);
          }
          // Keep the response open long enough for the PTY assertion to
          // sample the in-progress turn rather than its final Static block.
          await Bun.sleep(3_000);
          send({ content: "STREAM-FINISHED" });
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
