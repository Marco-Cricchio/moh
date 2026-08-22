import { McpError } from "./errors";
import { JsonRpcConnection, type ServerHandlers } from "./json-rpc";

export class HttpConnection extends JsonRpcConnection {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  #sessionId: string | null = null;

  constructor(
    opts: {
      url: string;
      headers?: Record<string, string>;
    } & ServerHandlers,
  ) {
    super(opts);
    this.#url = opts.url;
    this.#headers = opts.headers ?? {};
  }

  protected async send(text: string): Promise<void> {
    // Streamable HTTP: each message is a POST; responses may be JSON or SSE.
    // The session id assigned by the server at initialize time is captured below.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.#headers,
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    let res: Response;
    try {
      res = await fetch(this.#url, { method: "POST", headers, body: text });
    } catch (err) {
      throw new McpError("start_failed", `MCP endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new McpError("protocol", `MCP endpoint returned HTTP ${res.status}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.#sessionId = sid;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // SSE response: route every decoded message; the caller's promise
      // resolves when the response carrying the matching id arrives.
      await this.#drainSse(res);
      return;
    }
    const body = await res.text();
    if (body.trim()) this.handleMessage(JSON.parse(body));
  }

  async #drainSse(res: Response): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        try {
          this.handleMessage(JSON.parse(data));
        } catch {
          // ignore malformed frames
        }
      }
    }
  }

  /** Server-initiated requests over streamable HTTP are answered via POST. */
  async respondError(id: number | string, code: number, message: string): Promise<void> {
    try {
      await this.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
    } catch {
      // best effort; refusals are already recorded in the session log
    }
  }

  protected async shutdown(): Promise<void> {
    // Stateless from our side; nothing to close.
  }
}
