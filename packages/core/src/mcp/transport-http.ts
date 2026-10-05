import { McpError } from "./errors";
import { isHttpMcpUrl } from "./types";
import { JsonRpcConnection, type ServerHandlers } from "./json-rpc";

/** audit-v3 MCP-1: a response — JSON body or the SSE stream read so far —
 * is capped. A hostile server cannot balloon the session's memory through
 * one transport. Generous next to real tool payloads (host-scope caps a
 * fetch body at 1 MB); far below an unbounded read. */
export const MCP_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

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
    // Defense in depth under the config-schema refine: a declaration that
    // bypassed config resolution fails the server at start, loudly.
    if (!isHttpMcpUrl(opts.url)) {
      throw new McpError("start_failed", `MCP http server url must be an http(s) URL, got: ${opts.url}`);
    }
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
    const body = await this.#readCapped(res);
    if (body.trim()) this.handleMessage(JSON.parse(body));
  }

  async #drainSse(res: Response): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MCP_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new McpError("protocol", `MCP response exceeded the ${Math.round(MCP_MAX_RESPONSE_BYTES / (1024 * 1024))} MB cap`);
      }
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

  /** The JSON path of `send`, read incrementally so the byte cap applies. */
  async #readCapped(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let out = "";
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MCP_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new McpError("protocol", `MCP response exceeded the ${Math.round(MCP_MAX_RESPONSE_BYTES / (1024 * 1024))} MB cap`);
      }
      out += decoder.decode(value, { stream: true });
    }
    return out;
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
