import { expect, test } from "bun:test";
import { hasPython, runPtyRaw } from "./pty-runner";

// 777.mov: judge what the reader sees while the provider is paused, not
// merely uniqueness after settlement. The open list item is already sent.
test.skipIf(!hasPython)("an open Markdown item is readable before its semantic close", async () => {
  let sentOpenItem = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finish_reason: string | null = null) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "continuity", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
          };
          send({ role: "assistant" });
          send({ content: "Architecture overview.\n\n" });
          await Bun.sleep(250);
          send({ content: "1. **Core headless** OPEN-ITEM-ALREADY-SENT is readable while the provider has not closed this item" });
          sentOpenItem = true;
          await held;
          send({ content: ".\n\nReply complete." });
          send({}, "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const meta = await runPtyRaw({
      cols: 149, rows: 40,
      config: {
        onboarded: true, workflowOffered: true, mode: "vibe", showReasoning: false, provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-key", defaultModel: "fake-model" }],
      },
      steps: [
        { wait: 1 }, { send: btoa("architecture"), wait: 0.2 }, { send: btoa("\r"), wait: 0.2 },
        { wait: 4, until: "OPEN-ITEM-ALREADY-SENT", checkpoint: "openItem" },
      ],
      tail: 40,
    });
    expect(sentOpenItem).toBe(true);
    expect(meta.aliveAtEnd).toBe(true);
    const frame = meta.checkpoints!.openItem!;
    const visible = [...frame.scrollback, ...frame.lines.map((line) => line.text)].join("\n");
    expect(visible).toContain("Architecture overview.");
    expect(visible).toContain("OPEN-ITEM-ALREADY-SENT");
  } finally {
    release?.();
    server.stop(true);
  }
}, 15_000);
