/** A fake openai-compat SSE server for the #874 viewport-flicker
 * regression: a bash tool chain builds a long settled transcript first
 * (the shape of a real long session), then the final model call raises
 * the same oversized ask_user box as the #622 fixture. The test watches
 * the idle/blocked window after the gate opens for clearTerminal churn. */
const TALL_ASK = {
  questions: [
    {
      question:
        "tall box question — pick one route among many; this box is intentionally very tall so its rendered height must exceed the terminal viewport:",
      header: "Route",
      options: Array.from({ length: 4 }, (_, i) => ({
        label: `route-${i}`,
        description: Array.from(
          { length: 12 },
          (_, j) => `option ${i} description line ${j}: padded descriptive prose to consume viewport rows`,
        ).join(" "),
      })),
    },
  ],
};

/** Long prose per chain step: the settled transcript exceeds the viewport. */
const LONG_TEXT = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(40);

const CHAIN = 8;

export function startFakeOpenAiLongSessionAsk(port = 0): { server: ReturnType<typeof Bun.serve>; url: string } {
  let call = 0;
  const server = Bun.serve({
    port,
    async fetch(req) {
      call += 1;
      const toolCalls: { name: string; args: unknown }[] = [];
      let finish = "stop";
      if (call <= CHAIN) {
        toolCalls.push({ name: "bash", args: { command: "ls" } });
        finish = "tool_calls";
      } else if (call === CHAIN + 1) {
        toolCalls.push({ name: "ask_user", args: TALL_ASK });
        finish = "tool_calls";
      }
      const chunks: unknown[] = [
        { id: `c${call}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      ];
      if (call <= CHAIN) {
        for (let i = 0; i < 8; i++) {
          chunks.push({ id: `c${call}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: LONG_TEXT }, finish_reason: null }] });
        }
      }
      toolCalls.forEach((tc, i) => {
        chunks.push({
          id: `c${call}`, object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: i, id: `call_${call}_${i}`, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } }] },
            finish_reason: null,
          }],
        });
      });
      chunks.push({ id: `c${call}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
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
