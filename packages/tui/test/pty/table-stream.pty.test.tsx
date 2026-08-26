import { describe, expect, test } from "bun:test";
import { hasPython, runPty } from "./pty-runner";

const encodeBase64 = (s: string) => btoa(String(s));

/** Real-session regression (#227): a GFM table streamed row by row must end
 * up rendered as a table in the final scrollback, not as raw pipes. */
function startTableStream(): { server: ReturnType<typeof Bun.serve>; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const encoder = new TextEncoder();
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        encoder.encode(`data: ${JSON.stringify({
          id: "table-stream", object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(chunk({ role: "assistant" }));
          controller.enqueue(chunk({ content: "Ecco il quadro.\n\n" }));
          await Bun.sleep(300);
          const rows = [
            "| PR | Issue | Titolo |\n",
            "|---|---|---|\n",
            "| #212 | #211 | Allineamento body |\n",
            "| #214 | #213 | Chrome dev-mode |\n",
            "| #216 | #215 | Permessi auto-accept |\n",
            "\n",
            "Nessun CI configurato. Fine del riepilogo.\n",
          ];
          for (const row of rows) {
            controller.enqueue(chunk({ content: row }));
            await Bun.sleep(250);
          }
          await Bun.sleep(400);
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

describe.skipIf(!hasPython)("streamed table renders (#227)", () => {
  test("row-by-row table ends rendered, not raw pipes", async () => {
    const { server, url } = startTableStream();
    try {
      const lines = await runPty({
        cols: 120, rows: 40,
        config: {
          onboarded: true, workflowOffered: true, mode: "vibe", provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        steps: [
          { wait: 1.0 },
          { wait: 0.2, send: encodeBase64("riepiloga") },
          { wait: 0.2, send: encodeBase64("\r") },
          { wait: 4.0 },
        ],
        tail: 60,
      });
      const frame = lines.map((line) => line.text).join("\n");
      // The full table must land in the final scrollback with borders, not
      // raw pipes, and no row may be lost to a premature Static promotion.
      expect(frame).toContain("┌");
      expect(frame).toContain("│ #212");
      expect(frame).toContain("│ #216");
      expect(frame).toContain("Nessun CI configurato");
      expect(frame).not.toMatch(/\|---\|/);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
