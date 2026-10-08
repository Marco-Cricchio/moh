import { McpError } from "./errors";
import { isHttpMcpUrl } from "./types";
import { JsonRpcConnection, type ServerHandlers } from "./json-rpc";

/** audit-v3 MCP-1: a response — JSON body or the SSE stream read so far —
 * is capped. A hostile server cannot balloon the session's memory through
 * one transport. Generous next to real tool payloads (host-scope caps a
 * fetch body at 1 MB); far below an unbounded read. */
export const MCP_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** #1254: per-request budget for every POST (the handshake timeout bounds
 * only initialize; a slow endpoint must not hold a send() open forever). */
export const MCP_REQUEST_TIMEOUT_MS = 10_000;

/** Injectable DNS resolution (the fetch tool's FetchLookup seam, #697):
 * tests drive the rebinding scenario deterministically; production uses
 * `node:dns/promises.lookup({ all: true })`. */
export type McpLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

function isNumericHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

const defaultLookup: McpLookup = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  return lookup(hostname, { all: true });
};

export class HttpConnection extends JsonRpcConnection {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #lookup: McpLookup;
  #sessionId: string | null = null;

  constructor(
    opts: {
      url: string;
      headers?: Record<string, string>;
      lookup?: McpLookup;
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
    this.#lookup = opts.lookup ?? defaultLookup;
  }

  /** The resolved address set of one hop's host (numeric literals need no
   * DNS). A failed lookup refuses the hop — never a silent unpinned dial. */
  async #addressSet(url: URL): Promise<string[]> {
    if (isNumericHost(url.hostname)) return [url.hostname.replace(/^\[|\]$/g, "")];
    let addresses: { address: string; family: number }[];
    try {
      addresses = await this.#lookup(url.hostname);
    } catch (err) {
      throw new McpError("protocol", `MCP endpoint hostname "${url.hostname}" does not resolve: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (addresses.length === 0) throw new McpError("protocol", `MCP endpoint hostname "${url.hostname}" resolves to no addresses`);
    return addresses.map((a) => a.address).sort();
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
      // Redirects are followed by hand so every hop is pinned to the
      // configured origin: a cross-origin redirect is refused loudly and
      // session headers are never replayed to another host. Layer two
      // (#1254 remediation, after the fetch tool's #697 pattern): the
      // chain's first hop resolves once and every subsequent hop must
      // re-resolve to the SAME address set before it is dialed — a
      // rebinding hostname keeping its URL is refused. Residual: fetch's
      // socket still re-resolves internally, so the pin is verify-per-hop,
      // not the fetch tool's socket-level lookup hook — a hop could
      // theoretically re-resolve again between its verification and its
      // dial; the window is per-hop, not per-chain.
      let current = this.#url;
      let anchor: string[] | null = null;
      for (let hop = 0; hop < 10; hop += 1) {
        const resolved = await this.#addressSet(new URL(current));
        if (anchor === null) anchor = resolved;
        else if (resolved.join(",") !== anchor.join(",")) {
          throw new McpError("protocol", `MCP endpoint hostname re-resolved to a different address (${anchor.join(", ")} -> ${resolved.join(", ")}); redirect refused`);
        }
        const step = await fetch(current, { method: "POST", headers, body: text, redirect: "manual", signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS) });
        if (step.status >= 300 && step.status < 400 && step.headers.get("location")) {
          const next = new URL(step.headers.get("location")!, current);
          if (next.origin !== new URL(current).origin) {
            throw new McpError("protocol", `MCP endpoint redirected cross-origin (${current} -> ${next}); redirect refused`);
          }
          current = next.toString();
          continue;
        }
        res = step;
        break;
      }
      // @ts-expect-error assigned in every non-exhausted loop iteration
      if (!res) throw new McpError("protocol", "MCP endpoint exceeded the redirect limit");
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new McpError("timeout", `MCP endpoint request timed out after ${MCP_REQUEST_TIMEOUT_MS}ms`);
      }
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
