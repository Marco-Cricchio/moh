/**
 * MCP integration (#15 / issue #35): external tool sources over stdio and
 * HTTP streamable transports. Servers are declared in moh.json (project
 * scope, consent on first use) or `~/.moh/config` (user scope, trusted).
 *
 * - Tools are registered as `mcp__<server>__<tool>` under the standard
 *   Tool contract and permission spine; unmatched names fall through the
 *   resolver to "ask" (stricter default than built-ins).
 * - Servers start lazily on first use (first turn) and shut down at
 *   session end. A crash makes the server's tools unavailable until a
 *   manual `restart()`; there is no auto-restart.
 * - Tools only: sampling, roots and elicitation requests from servers
 *   are refused cleanly (JSON-RPC -32601) and the refusal is recorded in
 *   the session log as an `mcp_refused` event.
 */
import { z } from "zod";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Tool, ToolContext } from "./types";

/** Handshake budget. A server that does not answer `initialize` in time fails. */
export const MCP_HANDSHAKE_TIMEOUT_MS = 10_000;

export const PROTOCOL_VERSION = "2025-06-18";

/**
 * The MCP error taxonomy. Distinct from provider errors: these classify
 * transport/lifecycle failures of external tool sources. `handshake_timeout`
 * is the categorized 10s-timeout failure mode.
 */
export type McpErrorKind =
  | "start_failed" // process could not be spawned / endpoint unreachable
  | "handshake_timeout" // initialize not answered within the budget
  | "timeout" // post-handshake request timed out (e.g. tools/call)
  | "crashed" // running server died or the connection broke
  | "protocol" // well-formed transport, invalid MCP payloads
  | "unavailable"; // used after a crash/stop without a manual restart

export class McpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** moh.json / ~/.moh/config `mcpServers` entry (per server, keyed by name). */
export const mcpServerEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Project servers only: consent already given and persisted ("always"). */
    trusted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    trusted: z.boolean().optional(),
  }),
]);

export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;

/** A resolved server declaration: entry + name + trust scope. */
export interface DeclaredMcpServer {
  name: string;
  /** "project" servers ask consent on first use; "user" servers never ask. */
  scope: "project" | "user";
  transport: McpServerEntry;
}

/** Server lifecycle states visible to clients (e.g. `moh mcp list`). */
export type McpServerState = "stopped" | "starting" | "running" | "crashed" | "failed" | "denied";

export type McpConsentAnswer = "yes" | "always" | "no";

export interface McpRuntimeOptions {
  /** Merged project + user declarations; duplicate names are a startup error. */
  servers: DeclaredMcpServer[];
  cwd?: string;
  /** Handshake budget. Default 10s (MCP_HANDSHAKE_TIMEOUT_MS). */
  handshakeTimeoutMs?: number;
  /** Session-log seam: lifecycle and refusal events land here. */
  onEvent: (event: AgentEvent) => void;
  /**
   * Consent callback for project-scope servers, asked once before the
   * first start. Without it (headless) the server is denied and skipped.
   */
  onConsent?: (server: string) => Promise<McpConsentAnswer> | McpConsentAnswer;
  /** "always" at server level: persist trust (moh.json `mcpServers.<name>.trusted`). */
  onTrust?: (server: string) => void;
  /** Tools of trusted (user-scope or trusted) servers; the session allow-lists them. */
  onTrustedTools?: (toolNames: string[]) => void;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * Reads user-scope MCP servers from `~/.moh/config` (trusted, never ask).
 * Invalid entries are skipped: user chrome never hard-fails a session.
 */
export function loadUserMcpServers(file = join(homedir(), ".moh", "config")): Record<string, McpServerEntry> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const servers = (raw as { mcpServers?: Record<string, unknown> })?.mcpServers;
  if (typeof servers !== "object" || servers === null) return {};
  const out: Record<string, McpServerEntry> = {};
  for (const [name, value] of Object.entries(servers)) {
    const parsed = mcpServerEntrySchema.safeParse(value);
    if (parsed.success) out[name] = parsed.data;
  }
  return out;
}

/** User-scope servers as trusted declarations (they never ask for consent). */
export function declaredUserMcpServers(file?: string): DeclaredMcpServer[] {
  return Object.entries(loadUserMcpServers(file)).map(([name, transport]) => ({ name, scope: "user" as const, transport }));
}

const REFUSED_CAPABILITIES: Record<string, "sampling" | "roots" | "elicitation"> = {
  "sampling/createMessage": "sampling",
  "roots/list": "roots",
  "elicitation/create": "elicitation",
};

interface ServerHandlers {
  /** Server -> client request; may be refused (capabilities we do not support). */
  onRequest(method: string, id: number | string): void;
  onCrash(): void;
}

interface Connection {
  request(method: string, params: unknown, timeoutMs: number, timeoutKind?: McpErrorKind): Promise<unknown>;
  notify(method: string, params: unknown): void;
  respondError(id: number | string, code: number, message: string): void;
  close(): Promise<void>;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** JSON-RPC bookkeeping shared by both transports. */
abstract class JsonRpcConnection implements Connection {
  #nextId = 1;
  readonly #pending = new Map<number | string, PendingEntry>();
  readonly #handlers: ServerHandlers;
  #closed = false;

  constructor(handlers: ServerHandlers) {
    this.#handlers = handlers;
  }

  protected get closed(): boolean {
    return this.#closed;
  }

  protected nextId(): number {
    return this.#nextId++;
  }

  async request(method: string, params: unknown, timeoutMs: number, timeoutKind: McpErrorKind = "handshake_timeout"): Promise<unknown> {
    const id = this.nextId();
    const message = { jsonrpc: "2.0" as const, id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpError(timeoutKind, `MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.send(JSON.stringify(message));
    } catch (err) {
      // The inner promise was rejected by failPending; mark it handled so
      // only the awaited request() rejection surfaces.
      promise.catch(() => {});
      this.failPending(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async respondError(id: number | string, code: number, message: string): Promise<void> {
    await this.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  /** Routes one decoded JSON-RPC message (response or server request). */
  protected handleMessage(msg: unknown): void {
    const m = msg as { id?: number | string; result?: unknown; error?: { message?: string }; method?: string };
    if (m && typeof m === "object" && m.method !== undefined && m.id !== undefined) {
      // Server -> client request: tools only, capabilities refused cleanly.
      this.#handlers.onRequest(m.method, m.id);
      return;
    }
    if (m && typeof m === "object" && m.id !== undefined) {
      const pending = this.#pending.get(m.id);
      if (!pending) return;
      this.#pending.delete(m.id);
      clearTimeout(pending.timer);
      if (m.error) pending.reject(new McpError("protocol", m.error.message ?? "MCP error response"));
      else pending.resolve(m.result);
    }
    // Notifications from the server: ignored (tools only, no resources/prompts).
  }

  protected failPending(err: Error): void {
    this.#failPending(err);
  }

  #failPending(err: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  markCrashed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(new McpError("crashed", "MCP connection lost"));
    this.#handlers.onCrash();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#failPending(new McpError("unavailable", "MCP connection closed"));
    await this.shutdown();
  }

  protected abstract send(text: string): Promise<void>;
  protected abstract shutdown(): Promise<void>;
}

class StdioConnection extends JsonRpcConnection {
  readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #encoder = new TextEncoder();

  constructor(
    opts: {
      command: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
    } & ServerHandlers,
  ) {
    super(opts);
    try {
      this.#proc = Bun.spawn([opts.command, ...opts.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
    } catch (err) {
      throw new McpError("start_failed", `could not start MCP server: ${err instanceof Error ? err.message : String(err)}`);
    }
    void this.#readLoop();
    // Process exit while open = crash (no auto-restart).
    void this.#proc.exited.then(() => this.markCrashed());
  }

  async #readLoop(): Promise<void> {
    const reader = (this.#proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            this.handleMessage(JSON.parse(line));
          } catch {
            // Non-JSON noise on stdout: ignored (stderr is where it belongs).
          }
        }
      }
    } catch {
      // read errors surface via proc.exited -> markCrashed
    }
    this.markCrashed();
  }

  protected async send(text: string): Promise<void> {
    try {
      this.#proc.stdin.write(`${text}\n`);
    } catch {
      throw new McpError("crashed", "MCP server stdin closed");
    }
  }

  protected async shutdown(): Promise<void> {
    this.#proc.kill();
    await this.#proc.exited;
  }
}

class HttpConnection extends JsonRpcConnection {
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

  /** Captures the session id assigned by the server at initialize time. */

  protected async send(text: string): Promise<void> {
    // Streamable HTTP: each message is a POST; responses may be JSON or SSE.
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

interface RunningServer {
  conn: Connection;
  tools: string[];
}

/**
 * Owns the lifecycle of every declared MCP server for one session:
 * lazy start, consent, tool registration, crash tracking and shutdown.
 */
export class McpRuntime {
  readonly #servers: DeclaredMcpServer[];
  readonly #cwd: string | undefined;
  readonly #timeoutMs: number;
  readonly #onEvent: (event: AgentEvent) => void;
  readonly #onConsent: McpRuntimeOptions["onConsent"];
  readonly #onTrust: McpRuntimeOptions["onTrust"];
  readonly #onTrustedTools: McpRuntimeOptions["onTrustedTools"];
  readonly #state = new Map<string, McpServerState>();
  readonly #running = new Map<string, RunningServer>();
  readonly #tools = new Map<string, Tool>();
  #started = false;

  constructor(opts: McpRuntimeOptions) {
    this.#servers = opts.servers;
    this.#cwd = opts.cwd;
    this.#timeoutMs = opts.handshakeTimeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS;
    this.#onEvent = opts.onEvent;
    this.#onConsent = opts.onConsent;
    this.#onTrust = opts.onTrust;
    this.#onTrustedTools = opts.onTrustedTools;
    for (const s of opts.servers) this.#state.set(s.name, "stopped");
  }

  /**
   * Startup validation: server names must be unique (they are part of
   * every tool name). A collision is a hard configuration error.
   */
  static validate(servers: DeclaredMcpServer[]): void {
    const seen = new Set<string>();
    for (const s of servers) {
      if (seen.has(s.name)) throw new Error(`duplicate MCP server name "${s.name}" (project and user servers must be uniquely named)`);
      seen.add(s.name);
    }
  }

  /** Declared servers with their current lifecycle state. */
  status(): { name: string; scope: "project" | "user"; state: McpServerState; tools: string[] }[] {
    return this.#servers.map((s) => ({
      name: s.name,
      scope: s.scope,
      state: this.#state.get(s.name) ?? "stopped",
      tools: this.#running.get(s.name)?.tools ?? [],
    }));
  }

  /** Registered MCP tools (`mcp__<server>__<tool>`), keyed by full name. */
  get tools(): Record<string, Tool> {
    return Object.fromEntries(this.#tools);
  }

  /**
   * Lazily starts every declared server: consent gate for project servers,
   * handshake, tool registration. Idempotent; failures are per-server.
   */
  async ensureStarted(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const server of this.#servers) {
      const state = this.#state.get(server.name);
      if (state !== "stopped") continue;
      if (server.scope === "project" && !server.transport.trusted && !(await this.#consent(server.name))) continue;
      await this.#connect(server);
    }
  }

  async #consent(name: string): Promise<boolean> {
    this.#onEvent({ type: "permission_requested", callId: `mcp:${name}`, tool: `mcp__${name}` });
    let answer: McpConsentAnswer = "no";
    if (this.#onConsent) {
      answer = await this.#onConsent(name);
    }
    if (answer === "no") {
      this.#onEvent({ type: "permission_denied", callId: `mcp:${name}`, tool: `mcp__${name}`, reason: this.#onConsent ? "user" : "headless" });
      this.#state.set(name, "denied");
      return false;
    }
    this.#onEvent({ type: "permission_granted", callId: `mcp:${name}`, tool: `mcp__${name}`, reason: "user" });
    if (answer === "always") this.#onTrust?.(name);
    return true;
  }

  async #connect(server: DeclaredMcpServer): Promise<void> {
    this.#state.set(server.name, "starting");
    try {
      const handlers: ServerHandlers = {
        onRequest: (method, id) => {
          // Tools only: sampling/roots/elicitation are refused cleanly
          // (-32601) and the refusal is recorded in the session log.
          const capability = REFUSED_CAPABILITIES[method];
          if (capability) {
            this.#onEvent({ type: "mcp_refused", server: server.name, capability });
          }
          const conn = connRef;
          if (conn) void conn.respondError(id, -32601, `moh does not support ${capability ?? method} (tools only)`);
        },
        onCrash: () => {
          if (this.#state.get(server.name) !== "running") return;
          this.#state.set(server.name, "crashed");
          // Tool wrappers stay registered so the model gets a clean
          // "unavailable, manual restart" error instead of unknown-tool noise.
          this.#running.delete(server.name);
          this.#onEvent({
            type: "mcp_server_failed",
            server: server.name,
            reason: "crashed",
            message: "MCP server crashed; its tools are unavailable until a manual restart (no auto-restart)",
          });
        },
      };
      let connRef: Connection;
      const conn =
        server.transport.type === "stdio"
          ? new StdioConnection({ command: server.transport.command, args: server.transport.args ?? [], env: server.transport.env, cwd: this.#cwd, ...handlers })
          : new HttpConnection({ url: server.transport.url, headers: server.transport.headers, ...handlers });
      connRef = conn;

      const result = (await conn.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "moh", version: "0.1.0" },
        },
        this.#timeoutMs,
      )) as { protocolVersion?: string };
      if (!result || typeof result !== "object") throw new McpError("protocol", "invalid initialize result");
      await conn.notify("notifications/initialized", {});
      const listed = (await conn.request("tools/list", {}, this.#timeoutMs)) as { tools?: { name: string; description?: string }[] };
      const mcpTools = listed?.tools ?? [];
      const run: RunningServer = { conn, tools: [] };
      for (const t of mcpTools) {
        const fullName = mcpToolName(server.name, t.name);
        this.#tools.set(fullName, this.#wrapTool(server.name, t.name, t.description));
        run.tools.push(fullName);
      }
      this.#running.set(server.name, run);
      this.#state.set(server.name, "running");
      this.#onEvent({ type: "mcp_server_started", server: server.name, tools: run.tools });
      // Trusted servers (user scope or persisted "always") never ask again.
      if (server.scope === "user" || server.transport.trusted) this.#onTrustedTools?.(run.tools);
    } catch (err) {
      const kind = err instanceof McpError ? err.kind : "start_failed";
      this.#state.set(server.name, "failed");
      this.#onEvent({
        type: "mcp_server_failed",
        server: server.name,
        reason: kind,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #wrapTool(server: string, tool: string, description: string | undefined): Tool {
    const fullName = mcpToolName(server, tool);
    return {
      name: fullName,
      description: description?.trim() || `Tool "${tool}" from MCP server "${server}".`,
      inputSchema: undefined, // MCP servers validate arguments themselves
      execute: async (_args: unknown, ctx: ToolContext): Promise<string> => {
        const run = this.#running.get(server);
        if (!run) {
          const state = this.#state.get(server);
          throw new McpError(
            "unavailable",
            state === "crashed"
              ? `MCP server "${server}" crashed; run \`moh mcp restart ${server}\` (no auto-restart)`
              : `MCP server "${server}" is not running (state: ${state ?? "stopped"})`,
          );
        }
        ctx.onProgress(`calling ${fullName}`);
        const result = (await run.conn.request(
          "tools/call",
          { name: tool, arguments: _args ?? {} },
          60_000,
          "timeout",
        )) as { content?: { type: string; text?: string }[]; isError?: boolean };
        const text = (result?.content ?? [])
          .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c)))
          .join("\n");
        if (result?.isError) throw new McpError("protocol", text || `MCP tool ${fullName} failed`);
        return text;
      },
    };
  }

  /** Manual restart of one server (e.g. after a crash). No auto-restart. */
  async restart(name: string): Promise<void> {
    const server = this.#servers.find((s) => s.name === name);
    if (!server) throw new McpError("unavailable", `unknown MCP server "${name}"`);
    const run = this.#running.get(name);
    if (run) {
      this.#state.set(name, "stopped");
      for (const t of run.tools) this.#tools.delete(t);
      this.#running.delete(name);
      await run.conn.close();
    }
    this.#state.set(name, "stopped");
    await this.#connect(server);
  }

  /** Session-end shutdown: stops every running server. Idempotent. */
  async shutdown(): Promise<void> {
    for (const [name, run] of [...this.#running]) {
      for (const t of run.tools) this.#tools.delete(t);
      this.#running.delete(name);
      this.#state.set(name, "stopped");
      await run.conn.close();
      this.#onEvent({ type: "mcp_server_stopped", server: name });
    }
  }
}
