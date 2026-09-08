import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPtyRaw } from "./pty-runner";

// Owner's acceptance sequence: reasoning fills the terminal, then a long
// Markdown reply pushes that history upward while its newest text stays
// readable. Old reply rows must reach native scrollback BEFORE semantic
// closure, not merely reappear when the final projection settles.
test.skipIf(!hasPython)("reasoning and an open long Markdown reply advance native scrollback", async () => {
  let emittedTail = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    fetch() {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finish_reason: string | null = null) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "natural-scroll", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
          };
          send({ role: "assistant" });
          for (let i = 0; i < 45; i++) {
            send({ reasoning_content: `REASONING-ROW-${String(i).padStart(2, "0")} checking the design before answering.\n` });
            await Bun.sleep(15);
          }
          // One open list item, deliberately taller than the terminal. Its
          // Markdown source remains open throughout the checkpoint.
          send({ content: "## Architecture\n\n1. **REPLY-FIRST-ROW** " });
          for (let i = 0; i < 65; i++) {
            send({ content: `DETAIL-${String(i).padStart(2, "0")} the core owns the agent loop and the clients display its events. ` });
            await Bun.sleep(20);
          }
          send({ content: "REPLY-LIVE-TAIL" });
          emittedTail = true;
          await held;
          send({ content: "\n\nReply complete." });
          send({}, "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const meta = await runPtyRaw({
      cols: 100, rows: 24,
      config: {
        onboarded: true, workflowOffered: true, mode: "vibe", showReasoning: true, provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-key", defaultModel: "fake-model", capabilities: { thinking: { format: "openai-effort", levels: ["low"] } } }],
      },
      steps: [
        { wait: 1 }, { send: btoa("explain the architecture"), wait: 0.2 }, { send: btoa("\r"), wait: 0.2 },
        // The char cursor (~200 chars/s) reaches the stream tail (~2.2k
        // chars in) after ~11s of reveal — wait it out; the checkpoint is
        // exactly the mid-typing state this oracle exists to freeze.
        { wait: 30, until: "REPLY-LIVE-TAIL" },
        // The reveal cursor types at its own pace; give the reasoning
        // group time to seal and its rows to promote before freezing the
        // mid-stream frame (this oracle freezes mid-REPLY, mid-typing).
        { wait: 22, checkpoint: "longOpenReply" },
      ],
      tail: 24,
      rawDump: "/tmp/moh-natural-scrollback.bin",
    });
    expect(emittedTail).toBe(true);
    expect(meta.aliveAtEnd).toBe(true);
    const frame = meta.checkpoints!.longOpenReply!;
    const screen = frame.lines.map((line) => line.text).join("\n");
    expect(screen).toContain("REPLY-LIVE-TAIL");
    // Reasoning and reply-first-row must both have been painted (raw is
    // the authority: the harness Screen scrollback accounting varies with
    // pump timing under load, the raw byte stream does not).
    const raw = readFileSync("/tmp/moh-natural-scrollback.bin", "utf8");
    expect(raw).toContain("REASONING-ROW-00");
    expect(raw).toContain("REPLY-FIRST-ROW");
    // Exactly-once: promoted rows never re-print — the LAST paint of the
    // first reply row is final.
    const first = raw.lastIndexOf("REPLY-FIRST-ROW");
    expect(first).toBeGreaterThan(0);
    expect(raw.slice(first).split("REPLY-FIRST-ROW").length - 1).toBe(1);
    // Reasoning painted before the reply's first row ever appeared.
    expect(raw.indexOf("REASONING-ROW-44")).toBeLessThan(raw.indexOf("REPLY-FIRST-ROW"));
  } finally {
    release?.();
    server.stop(true);
  }
}, 45_000);
