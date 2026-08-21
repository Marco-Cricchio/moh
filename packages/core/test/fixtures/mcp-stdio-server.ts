/**
 * Test-only MCP stdio server (#15). Newline-delimited JSON-RPC over
 * stdin/stdout. Mode is passed as argv[2]:
 * - "ok": initialize + one `echo` tool
 * - "silent": never answers initialize (handshake-timeout fixture)
 * - "refuse": after answering tools/list, sends a sampling/createMessage
 *   request (must be refused with -32601)
 */
const mode = process.argv[2] ?? "ok";
const encoder = new TextEncoder();

function send(msg: unknown): void {
  process.stdout.write(encoder.encode(JSON.stringify(msg) + "\n"));
}

async function main(): Promise<void> {
  if (mode === "silent") {
    await Bun.sleep(60_000);
    return;
  }
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: any };
      if (msg.method === "initialize" && msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "0.0.1" } } });
      } else if (msg.method === "tools/list" && msg.id !== undefined) {
        if (mode === "refuse") {
          send({ jsonrpc: "2.0", id: 9001, method: "sampling/createMessage", params: {} });
        }
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [{ name: "echo", description: "Echo the input text", inputSchema: { type: "object" } }] },
        });
      } else if (msg.method === "tools/call" && msg.id !== undefined) {
        if (msg.params?.arguments?.boom) {
          process.exit(1); // crash fixture: die without answering
        }
        const text = msg.params?.arguments?.text ?? "";
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo: ${text}` }] } });
      } else if (msg.id !== undefined && msg.method) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      }
    }
  }
}

void main();
