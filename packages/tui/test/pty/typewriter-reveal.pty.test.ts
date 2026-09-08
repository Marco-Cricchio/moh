import { expect, test } from "bun:test";
import { hasPython, runPtyRaw } from "./pty-runner";

// Owner 777.mov follow-up: replies must form horizontally (typewriter),
// not land in provider-sized blocks. A burst delta must be revealed
// progressively: shortly after arrival the start is visible while the
// end is not; later the end is visible.
test.skipIf(!hasPython)("a burst reply is revealed progressively, not in one block", async () => {
  let sent = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { setTimeout(resolve, 9000); });
  const server = Bun.serve({
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "typewriter", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
          send({ role: "assistant" });
          // One big burst: no punctuation boundaries, plain prose.
          send({ content: `BURST-START ${"the core owns the agent loop and every client only projects its events while the reveal advances ".repeat(9)}BURST-END` });
          sent = true;
          await held;
          send({}, "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const meta = await runPtyRaw({
      cols: 100, rows: 30,
      config: {
        onboarded: true, workflowOffered: true, mode: "vibe", provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-key", defaultModel: "fake-model" }],
      },
      steps: [
        { wait: 1 }, { send: btoa("burst"), wait: 0.2 }, { send: btoa("\r"), wait: 0.2 },
        { wait: 5, until: "BURST-START" },
        { wait: 1.2, checkpoint: "midReveal" },
        { wait: 8, checkpoint: "lateReveal" },
      ],
      tail: 30,
    });
    expect(sent).toBe(true);
    expect(meta.aliveAtEnd).toBe(true);
    const early = meta.checkpoints!.midReveal!;
    const earlyScreen = early.lines.map((line) => line.text).join("\n");
    expect(earlyScreen).toContain("BURST-START");
    // Progressive reveal: the burst tail is NOT on screen yet.
    expect(earlyScreen).not.toContain("BURST-END");
    const late = meta.checkpoints!.lateReveal!;
    const lateAll = [...late.scrollback, ...late.lines.map((line) => line.text)].join("\n");
    expect(lateAll).toContain("BURST-END");
    // And it lands exactly once.
    expect(lateAll.split("BURST-END").length - 1).toBe(1);
  } finally {
    release?.();
    server.stop(true);
  }
}, 20_000);
