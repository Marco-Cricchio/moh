/** A fake openai-compat SSE server for PTY tests: a tool chain builds a
 * large transcript, then FOUR ask_user calls in one parallel block (the
 * shape of the real failing session 20260825T062108113Z).
 */
const REAL_ASK = { question: "Q1 — which way?", options: [{ label: "alpha", description: "first" }, { label: "beta", description: "second" }, { label: "gamma", description: "third" }], suggested: "alpha" };
const LONG_TEXT = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(40);

const CHAIN = 15; // tool-chain length (< default 50 iteration cap)

export function startFakeOpenAi(port = 0): { server: ReturnType<typeof Bun.serve>; url: string } {
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
        for (let i = 0; i < 4; i++) toolCalls.push({ name: "ask_user", args: REAL_ASK });
        finish = "tool_calls";
      }
      const chunks: unknown[] = [
        { id: `c${call}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      ];
      if (call <= CHAIN) {
        for (let i = 0; i < 20; i++) {
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
  const { url } = startFakeOpenAi(8787);
  console.log(`fake openai-compat on ${url}`);
  setInterval(() => {}, 1000);
}
