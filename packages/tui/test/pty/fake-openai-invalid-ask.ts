/** A fake openai-compat SSE server for the ask_user invalid-then-valid
 * regression: call 1 emits an ask_user with a 15-char header (validation
 * error), call 2 (after the error result) re-emits a valid 4-question set,
 * call 3 wraps up.
 */
const INVALID_ASK = { questions: [{ question: "Q1 — which way?", header: "Logica/visiva", options: [{ label: "alpha", description: "first" }, { label: "beta", description: "second" }] }] };
const VALID_ASK = {
  questions: [
    { question: "Q1 — which way?", header: "Route", options: [{ label: "alpha", description: "first" }, { label: "beta", description: "second" }, { label: "gamma", description: "third" }], suggested: "alpha" },
    { question: "Q2 — how fast?", header: "Speed", options: [{ label: "slow", description: "s" }, { label: "fast", description: "f" }], suggested: "slow" },
  ],
};

export function startFakeOpenAi(port = 0): { server: ReturnType<typeof Bun.serve>; url: string } {
  let call = 0;
  const server = Bun.serve({
    port,
    async fetch(req) {
      call += 1;
      const toolCalls: { name: string; args: unknown }[] = [];
      let finish = "stop";
      if (call === 1) {
        toolCalls.push({ name: "ask_user", args: INVALID_ASK });
        finish = "tool_calls";
      } else if (call === 2) {
        toolCalls.push({ name: "ask_user", args: VALID_ASK });
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

if (import.meta.main) {
  const { url } = startFakeOpenAi(8788);
  console.log(`fake openai-compat on ${url}`);
  setInterval(() => {}, 1000);
}
