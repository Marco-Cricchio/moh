/** A fake openai-compat SSE server for the #622 oversized-ask regression:
 * one ask_user call whose rendered height exceeds the PTY viewport (4
 * options is the validation cap; the multi-line descriptions push the box
 * past 20 rows). */
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

export function startFakeOpenAiOversizedAsk(port = 0): { server: ReturnType<typeof Bun.serve>; url: string } {
  let call = 0;
  const server = Bun.serve({
    port,
    async fetch(req) {
      call += 1;
      const toolCalls: { name: string; args: unknown }[] = [];
      let finish = "stop";
      if (call === 1) {
        toolCalls.push({ name: "ask_user", args: TALL_ASK });
        finish = "tool_calls";
      }
      const chunks: unknown[] = [
        { id: `c${call}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      ];
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
      if (finish === "stop") {
        chunks.push({ id: `c${call}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "all set" }, finish_reason: null }] });
      }
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
