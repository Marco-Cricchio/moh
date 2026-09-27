import { expect, test } from "bun:test";
import { hasPython, runPtyRaw } from "./pty-runner";
import { COMPOSER_COMPACT, COMPOSER_READY } from "../helpers";

// Owner 777.mov follow-up: replies must form horizontally (typewriter),
// not land in provider-sized blocks. A burst delta must be revealed
// progressively: shortly after arrival the start is visible while the
// end is not; later the end is visible.
test.skipIf(!hasPython)("a burst reply is revealed progressively, not in one block", async () => {
  let sent = false;
  let release: (() => void) | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
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
          // Hold from response arrival, not server startup: boot time must
          // not consume the window in which progressive reveal is observed.
          await new Promise<void>((resolve) => {
            release = resolve;
            holdTimer = setTimeout(resolve, 9000);
          });
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
      env: { MOH_TYPEWRITER_MS: "60", MOH_TYPEWRITER_CHARS: "10" },
      config: {
        onboarded: true, workflowOffered: true, mode: "vibe", provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-key", defaultModel: "fake-model" }],
      },
      steps: [
        { wait: 1 }, { send: btoa("burst"), wait: 0.2 }, { send: btoa("\r"), wait: 0.2 },
        // Observe the head immediately, even if it painted during send.
        { wait: 5, until: "BURST-START", untilOnScreen: true, checkpoint: "midReveal" },
        // Growth while the response is still held: a reveal that showed a
        // prefix, froze, and dumped the rest at settle must fail here.
        { wait: 2.5, checkpoint: "progressed" },
        { wait: 10, until: "BURST-END", untilOnScreen: true, checkpoint: "lateReveal" },
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
    expect(earlyScreen).not.toContain("✓ done");
    // Visible burst characters, bounded by the transcript chrome below it.
    const revealedChars = (snapshot: NonNullable<typeof meta.checkpoints>[string]) => {
      const text = [...snapshot.scrollback, ...snapshot.lines.map((line) => line.text)].join(" ").replace(/\s+/g, " ");
      const from = text.indexOf("BURST-START");
      if (from < 0) return 0;
      const stop = ["BURST-END", COMPOSER_READY, "⏎ send"].map((marker) => text.indexOf(marker, from + 1)).filter((index) => index > 0).sort((a, b) => a - b)[0];
      return (stop ?? text.length) - from;
    };
    const progressed = meta.checkpoints!.progressed!;
    const progressedScreen = progressed.lines.map((line) => line.text).join("\n");
    expect(progressedScreen).not.toContain("✓ done");
    expect(revealedChars(progressed)).toBeGreaterThanOrEqual(revealedChars(early) + 100);
    const late = meta.checkpoints!.lateReveal!;
    const lateAll = [...late.scrollback, ...late.lines.map((line) => line.text)].join("\n");
    expect(lateAll).toContain("BURST-END");
    // And it lands exactly once.
    expect(lateAll.split("BURST-END").length - 1).toBe(1);
  } finally {
    if (holdTimer) clearTimeout(holdTimer);
    release?.();
    server.stop(true);
  }
}, 20_000);
