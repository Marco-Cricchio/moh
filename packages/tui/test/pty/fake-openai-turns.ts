/**
 * A fake openai-compat SSE endpoint that answers one UNIQUE needle per turn
 * (#1061). The `mock` provider answers the same canned text every turn, so a
 * multi-turn PTY script cannot prove per-turn readiness with a bare `until`
 * (with #1045's enforced readiness a needle already in the buffer returns
 * instantly — the trap the modal-return-anchor test documented). Here each
 * call paints `TURN-<n>-MARKER`, so every wait names something only that
 * turn can produce.
 */
export function startFakeOpenAiTurns(turns: number, port = 0): { server: ReturnType<typeof Bun.serve>; url: string } {
  let call = 0;
  const server = Bun.serve({
    port,
    fetch() {
      call += 1;
      const marker = `TURN-${call}-MARKER`;
      const encoder = new TextEncoder();
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
        encoder.encode(`data: ${JSON.stringify({
          id: `t${call}`, object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk({ role: "assistant" }));
          // Enough prose to fill a 30-row screen within a couple of turns,
          // so the interactive frame is pinned to the bottom rows — the
          // layout the anchor guard is about.
          controller.enqueue(chunk({ content: `${marker}\n\n` }));
          controller.enqueue(chunk({ content: `reply ${call} for the anchor scenario. `.repeat(40) }));
          controller.enqueue(chunk({}, "stop"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  void turns;
  return { server, url: `http://127.0.0.1:${server.port}/v1` };
}
