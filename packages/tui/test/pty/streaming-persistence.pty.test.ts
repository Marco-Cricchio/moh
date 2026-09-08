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
          { wait: 0.2, send: encodeBase64("\r"), checkpoint: "turnStart" },
          // The typewriter paces row reveal; wait until the tail has
          // visibly advanced, then snapshot the dock geometry mid-stream.
          { wait: 9.0, until: "MIDDLE-LINE-5", checkpoint: "midStream" },
        ],
        tail: 20,
        rawDump,
      });
      expect(meta.aliveAtEnd).toBe(true);
      // Provider still holding: the final marker must not be painted yet.
      const mid = meta.checkpoints?.midStream;
      expect(mid).toBeDefined();
      const midText = [...mid!.scrollback, ...mid!.lines.map((l) => l.text)].join("\n");
      expect(midText).toContain("MIDDLE-LINE-5");
      expect(midText).not.toContain("STREAM-FINISHED");
      expect(midText).not.toContain("LAST-LIVE-LINE");
      // Dock geometry: composer stays in the lower half mid-stream.
      const screen = mid!.lines.map((l) => l.text);
      const input = screen.findIndex((line) => line.includes("type…"));
      expect(input).toBeGreaterThanOrEqual(Math.floor(screen.length / 2));
      const startInput = meta.checkpoints?.turnStart?.lines.findIndex((line) => line.text.includes("type…"));
      expect(startInput).toBe(input);
      // Bounded output (no O(n²) flood).
      expect(readFileSync(rawDump).byteLength).toBeLessThan(500_000);
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("final settlement does not reprint a prose prefix already in scrollback", async () => {
    const { server, url } = startLineStream();
    const rawDump = "/tmp/moh-streaming-lines-settled-raw.bin";
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
          { wait: 0.2, send: encodeBase64("settled line stream") },
          { wait: 0.2, send: encodeBase64("\r") },
          { wait: 7.0, until: "STREAM-FINISHED" },
          // Post-settle: the whole transcript promotes once; snapshot after
          // the settle repaint has flushed.
          { wait: 1.5, checkpoint: "settled" },
        ],
        tail: 20,
        rawDump,
      });
      // The settled screen must show the full reply exactly once — volatile
      // pre-settlement repaints are allowed, post-settlement duplicates are
      // the 888.mov regression this guards.
      const settled = meta.checkpoints?.settled;
      expect(settled).toBeDefined();
      const settledText = [...settled!.scrollback, ...settled!.lines.map((l) => l.text)].join("\n");
      expect(settledText.split("FIRST-COMPLETED-LINE").length - 1).toBe(1);
      expect(settledText).toContain("LAST-LIVE-LINE");
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

  // Owner report 2026-09-07 (666.mov): the session's bullet list rendered
  // twice in vibe mode at the owner's real 149x40 geometry. The reply
  // appears exactly once in the log; physical screen + scrollback must
  // agree — the list items are the markers because the closing line could
  // still stream when the PTY snapshot lands.
  test("a session-style prose+list reply prints each bullet exactly once", async () => {
    const { server, url } = startSessionReplyStream();
    try {
      const meta = await runPtyRaw({
        cols: 149,
        rows: 40,
        config: {
          onboarded: true, workflowOffered: true, mode: "vibe", provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        steps: [
          { wait: 1.0 },
          { wait: 0.2, send: encodeBase64("parliamo di moh") },
          { wait: 0.2, send: encodeBase64("\r") },
          { wait: 15.0, until: "Cosa ti incuriosisce?" },
          { wait: 1.0 },
        ],
        tail: 40,
      });
      expect(meta.aliveAtEnd).toBe(true);
      const history = [...(meta.scrollback ?? []), ...meta.lines.map((line) => line.text)].join("\n");
      for (const marker of ["Come funziona", "Architettura", "Stato del lavoro", "Issue aperte", "Cosa ti incuriosisce"]) {
        expect(history.split(marker).length - 1, marker).toBe(1);
      }
    } finally {
      server.stop(true);
    }
  }, 30_000);

  // Owner report on production session 39276900 (2026-09-06, post-0.21.1):
  // outputs appeared doubled/tripled in an agentic turn — many model calls,
  // each with brief intermediate text between tool calls and reasoning
  // persisted at end of call (#326 pattern). Two calls were not enough to
  // reproduce; the fixture must exercise a long tool cycle sequence.
  test("a long tool cycle sequence prints each intermediate text exactly once", async () => {
    const { server, url } = startToolCycleStream();
    const rawDump = "/tmp/moh-streaming-toolcycles-raw.bin";
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
          { wait: 0.2, send: encodeBase64("run the cycles") },
          { wait: 0.2, send: encodeBase64("\r") },
          { wait: 5.0, until: "CYCLE-LIVE-TAIL-0", checkpoint: "midStream" },
          { wait: 20.0, until: "FINAL-REPLY-MARKER" },
          { wait: 0.8 },
        ],
        tail: 24,
        rawDump,
      });
      expect(meta.aliveAtEnd).toBe(true);
      const mid = meta.checkpoints?.midStream;
      expect(mid).toBeDefined();
      // #526: by the pause before late reasoning, closed sections must have
      // entered native scrollback. This is the physical append-only handoff;
      // the parser's instantaneous screen frame may be between Ink repaints.
      expect(mid!.scrollback.some((line) => line.includes("CYCLE-STATIC-0"))).toBe(true);
      const raw = readFileSync(rawDump, "utf8");
      expect(raw).toContain("FINAL-REPLY-MARKER");
      // Settled duplicate oracle: each intermediate text appears exactly
      // once in the terminal's final history (scrollback + screen).
      const history = [...(meta.scrollback ?? []), ...meta.lines.map((line) => line.text)].join("\n");
      for (let i = 1; i < 8; i++) {
        const marker = `CYCLE-TEXT-${i}`;
        const count = history.split(marker).length - 1;
        expect(count).toBe(1);
      }
      expect(history.split("CYCLE-STATIC-0").length - 1).toBe(1);
      const finalCount = history.split("FINAL-REPLY-MARKER").length - 1;
      expect(finalCount).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  // Production session cca11370 (v0.24.1): a GLM-style stream writes an
  // open Markdown list, late reasoning, then a tool batch. The event log has
  // every delta once, but Ink's volatile reprints had put individual bullets
  // into native scrollback twice before settlement. An open structured
  // Markdown segment must not enter the volatile tree; it lands once when
  // its call boundary settles into Static.
  test("open Markdown tool cycles enter terminal history exactly once", async () => {
    const { server, url } = startOpenMarkdownToolCycleStream();
    try {
      const meta = await runPtyRaw({
        cols: 52,
        rows: 18,
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
          { wait: 0.2, send: encodeBase64("run markdown cycles") },
          { wait: 0.2, send: encodeBase64("\r") },
          { wait: 25.0, until: "MARKDOWN-CYCLES-DONE" },
          { wait: 1.0 },
        ],
        tail: 18,
      });
      expect(meta.aliveAtEnd).toBe(true);
      const history = [...(meta.scrollback ?? []), ...meta.lines.map((line) => line.text)].join("\n");
      for (let cycle = 0; cycle < 6; cycle++) {
        for (const marker of [`MD-${cycle}-ALPHA`, `MD-${cycle}-BETA`, `MD-THINK-${cycle}`]) {
          expect(history.split(marker).length - 1, marker).toBe(1);
        }
      }
      expect(history.split("MARKDOWN-CYCLES-DONE").length - 1).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 35_000);

  // Production session 9695c69c (v0.23.1, PR #537 active): the model emits a
  // LONG streamed live reasoning paragraph, a long Markdown reply, then a
  // SECOND reasoning part for the SAME call (GLM multi-part flush), then
  // tools. The owner saw duplicated/triplicated thinking blocks and reply
  // blocks split by identical thinking copies; a mode toggle (full repaint)
  // normalized the screen — so the corruption is in the incremental chain
  // state, not in the log.
  // Owner report on v0.23.2: after a vibe->dev->vibe toggle the transcript
  // mixed grammars (vibe "ran a command · …" boxes visible in dev),
  // duplicated list items, and the toggle result was unstable. Cause: the
  // full-repaint path reset the projection state but not the Static
  // emission ledger, so the remounted Static (cursor restarts at zero)
  // saw stale keys as already-printed and old-grammar blocks survived the
  // screen wipe. The toggle must yield a coherent single-grammar
  // transcript at every step.
  test("mode toggle repaints one coherent grammar (no stale vibe/dev mixing)", async () => {
    const { server, url } = startToolCycleStream();
    try {
      const meta = await runPtyRaw({
        cols: 120,
        rows: 24,
        config: {
          onboarded: true, workflowOffered: true, mode: "vibe", provider: "fake", showReasoning: true,
          endpoints: [{
            name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model",
            capabilities: { thinking: { format: "openai-effort", levels: ["low"] } },
          }],
        },
        project: { permissions: { overrides: { tools: { glob: "allow" } } } },
        steps: [
          { wait: 1.0 },
          { wait: 0.2, send: encodeBase64("run the cycles") },
          { wait: 0.2, send: encodeBase64("\r") },
          // Toggle mid-stream, then back, then once more after settle.
          { wait: 3.0, send: encodeBase64("\x0f") },
          { wait: 1.0, send: encodeBase64("\x0f") },
          { wait: 20.0, until: "FINAL-REPLY-MARKER" },
          { wait: 0.5, send: encodeBase64("\x0f") },
          { wait: 1.2, send: encodeBase64("\x0f") },
          { wait: 1.2, send: encodeBase64("\x0f") },
          { wait: 1.2 },
        ],
        tail: 24,
      });
      expect(meta.aliveAtEnd).toBe(true);
      const finalFrame = meta.lines.map((line) => line.text).join("\n");
      // Final mode is dev (3 toggles from vibe): the screen must show the
      // dev grammar coherently — no vibe-phrase tool lines may survive the
      // last repaint — and the final reply must be present.
      expect(finalFrame).not.toContain("looked for files");
      expect(finalFrame).toContain("FINAL-REPLY-MARKER");
      const history = [...(meta.scrollback ?? []), ...meta.lines.map((line) => line.text)].join("\n");
      // Cycle markers stay unique across the whole terminal history despite
      // the three mid-stream/post-settle repaints.
      for (let i = 1; i < 4; i++) {
        const marker = `CYCLE-TEXT-${i}`;
        const count = history.split(marker).length - 1;
        expect(count).toBe(1);
      }
      expect(history.split("FINAL-REPLY-MARKER").length - 1).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 45_000);

  test("multi-part late reasoning per call prints each thinking block exactly once", async () => {
    const { server, url } = startMultiPartReasoningStream();
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
          { wait: 0.2, send: encodeBase64("think through the cycles") },
          { wait: 0.2, send: encodeBase64("\r") },
          { wait: 4.0, checkpoint: "afterCycle1" },
          { wait: 25.0, until: "FINAL-REPLY-MARKER" },
          { wait: 0.8 },
        ],
        tail: 24,
        rawDump: "/tmp/moh-multipart-raw.bin",
      });
      expect(meta.aliveAtEnd).toBe(true);
      const c1 = meta.checkpoints?.afterCycle1;
      const history = [...(meta.scrollback ?? []), ...meta.lines.map((line) => line.text)].join("\n");
      // Each call's thinking block is one physical emission, never
      // duplicated by the live→log handover or the settled projection.
      // NOTE: markers are matched WITHOUT the trailing index context, so
      // `PART-THINK-0` never counts `PART-THINK-0-TAIL`-style strings (the
      // tail part uses a distinct marker). On failure print which marker
      // missed to keep the PTY diagnosis actionable.
      for (let i = 0; i < 4; i++) {
        const marker = `PART-THINK-${i}`;
        const count = history.split(marker).length - 1;
        expect(count).toBe(1);
      }
      for (let i = 0; i < 4; i++) {
        const marker = `PART-REPLY-${i}`;
        const count = history.split(marker).length - 1;
        expect(count).toBe(1);
      }
      expect(history.split("FINAL-REPLY-MARKER").length - 1).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 40_000);
});

function startMultiPartReasoningStream(): { server: ReturnType<typeof Bun.serve>; url: string } {
  // Faithful to 9695c69c: long streamed reasoning → long Markdown reply →
  // a SECOND reasoning part for the same call → tool batch. 4 cycles, then
  // a final reply. Reasoning text is one long no-newline paragraph (GLM
  // style), so the live reasoning promotion wraps it visually.
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finishReason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: `multipart-${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`));
          send({ role: "assistant" });
          const isFinal = calls > 4;
          if (isFinal) {
            for (const word of "FINAL-REPLY-MARKER the multipart session is complete".split(/(?<=\s)/)) {
              send({ content: word });
              await Bun.sleep(8);
            }
            send({}, "stop");
          } else {
            const cycle = calls - 1;
            // Long streamed live reasoning (one paragraph, ~1000 chars).
            const reasoning = `PART-THINK-${cycle} ${"thinking through the tool result carefully before answering. ".repeat(22)}`;
            for (const word of reasoning.split(/(?<=\s)/)) {
              send({ reasoning_content: word });
              await Bun.sleep(4);
            }
            // Long Markdown reply.
            const reply = `\n\n## PART-REPLY-${cycle}\n\n${"A closed Markdown section answering the cycle. ".repeat(16)}\n\n- first finding\n- second finding\n\n`;
            for (const word of reply.split(/(?<=\s)/)) {
              send({ content: word });
              await Bun.sleep(4);
            }
            // Second reasoning part for the SAME call, late (#240/GLM).
            // Distinct marker (no shared prefix) so history counts cannot
            // conflate the tail part with the main thinking block.
            await Bun.sleep(120);
            send({ reasoning_content: `${"final check of the cycle result before the tool runs. ".repeat(12)}TAILPART-${cycle}` });
            for (let t = 0; t < 2; t++) {
              send({ tool_calls: [{ index: t, id: `glob-part-${calls}-${t}`, type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "*.md" }) } }] });
            }
            send({}, "tool_calls");
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

function startOpenMarkdownToolCycleStream(): { server: ReturnType<typeof Bun.serve>; url: string } {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finishReason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: `open-markdown-${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`));
          send({ role: "assistant" });
          if (calls > 6) {
            for (const word of "MARKDOWN-CYCLES-DONE the final reply has settled".split(/(?<=\s)/)) {
              send({ content: word });
              await Bun.sleep(6);
            }
            send({}, "stop");
          } else {
            const cycle = calls - 1;
            const reply = `\n## Cycle ${cycle}\n\nThe item list remains open while this model call streams.\n\n- MD-${cycle}-ALPHA\n- MD-${cycle}-BETA\n\n`;
            for (const word of reply.split(/(?<=\s)/)) {
              send({ content: word });
              await Bun.sleep(4);
            }
            // GLM persists reasoning after reply deltas, immediately before
            // the tool batch — the production ordering that exposed the
            // volatile Markdown scrollback duplication.
            send({ reasoning_content: `MD-THINK-${cycle} checking the tool result.` });
            send({ tool_calls: [{ index: 0, id: `open-md-${cycle}`, type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "*.md" }) } }] });
            send({}, "tool_calls");
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

/**
 * Owner report 2026-09-07 (docs/vision/666.mov, production session 43cc494c,
 * vibe mode 149x40, GLM 5.3 Flash, reasoning hidden): a plain conversational
 * answer — prose, then a bullet list, then a short closing line — rendered
 * its list twice in screen+scrollback. The log carries the reply once, so
 * the duplication is a rendering-path defect; the fixture replays the
 * exact delta text of the recorded session.
 */
function startSessionReplyStream(): { server: ReturnType<typeof Bun.serve>; url: string } {
  const sections = [
    "Certo! Con piacere — moh è il progetto qui in `/Users/mc/Documents/AI_Projects/moh`.",
    "\n\nIn due parole: **moh è un agente di coding provider-agnostic** — un core headless (`@moh/core`) che gira il loop dell'agente, con client TUI e CLI sopra, e il tutto guidato da principi architetturali piuttosto rigidi (sette principi in `docs/principles.md`, decisioni registrate come ADR).",
    "\n\nAlcuni temi di cui possiamo parlare:",
    "\n\n- **Come funziona** — sessioni, resume/fork, event log, memory, permessi, provider (c'è una pagina del manuale per ognuno: `moh manual <pagina>`)",
    "\n- **Architettura** — public surface del core, session assembly, phase hook per le estensioni",
    "\n- **Stato del lavoro** — c'è la branch `test/streaming-viewport-growth` con sei commit sulla nota 33 (streaming del reasoning/reply in scrollback) che aspetta la tua verifica con un video reale prima di aprire la PR, più il thread di PR #555 sul discovery dei modelli live",
    "\n- **Issue aperte** — posso listare la tracker",
    "\n\nCosa ti incuriosisce?",
  ];
  const server = Bun.serve({
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finishReason: string | null = null) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "session-reply", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`));
          send({ role: "assistant" });
          for (const section of sections) {
            for (const word of section.split(/(?<=\s)/)) {
              send({ content: word });
              await Bun.sleep(25);
            }
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

function startToolCycleStream(): { server: ReturnType<typeof Bun.serve>; url: string } {
  // Faithful to session 39276900: 8 tool cycles, each model call emits
  // brief intermediate text (plain prose, promoted early), reasoning
  // persisted at end of call (after the text — the GLM/#326 ordering),
  // then a tool call; the last call streams the final reply.
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finishReason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: `cycles-${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`));
          send({ role: "assistant" });
          const isFinal = calls > 8;
          if (isFinal) {
            for (const word of "FINAL-REPLY-MARKER the work is complete across every cycle and the answer settles here".split(/(?<=\s)/)) {
              send({ content: word });
              await Bun.sleep(8);
            }
            send({}, "stop");
          } else {
            const cycle = calls - 1;
            // Only cycle zero needs enough rows to probe the #526 viewport;
            // later cycles stay compact but retain the same Markdown + late-
            // reasoning ordering that stresses deduplication. This keeps the
            // combined oracle deterministic and below the PTY time budget.
            const sections = cycle === 0
              ? [
                `## CYCLE-STATIC-${cycle}\n\n${"Closed Markdown section that must enter native scrollback before reasoning. ".repeat(18)}`,
                `\n\n## CYCLE-MIDDLE-${cycle}\n\n${"A second closed section proves the append-only viewport does not rebuild its head. ".repeat(14)}`,
                `\n\n## CYCLE-LIVE-TAIL-${cycle}\n\n${"The newest open segment remains volatile while this call has not sealed. ".repeat(8)}`,
              ]
              : [`## CYCLE-TEXT-${cycle}\n\ninline \`step-${cycle}\`\n\n- first item\n- second item\n\nopen tail`];
            for (const section of sections) {
              for (const word of section.split(/(?<=\s)/)) {
                send({ content: word });
                await Bun.sleep(5);
              }
            }
            // Freeze before late reasoning to make the #526 viewport state
            // observable through the harness checkpoint.
            if (cycle === 0) await Bun.sleep(2_500);
            // Reasoning AFTER the text, persisted at call end (#326).
            await Bun.sleep(150);
            send({ reasoning_content: `CYCLE-THINKING-${calls - 1} check the tool result before continuing` });
            // Parallel tool batch, as the real agentic session emits.
            for (let t = 0; t < 3; t++) {
              send({ tool_calls: [{ index: t, id: `glob-cycles-${calls}-${t}`, type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: `*.md` }) } }] });
            }
            send({}, "tool_calls");
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
