import type { AgentEvent, Tool, ToolContext } from "../types";
import { MCP_HANDSHAKE_TIMEOUT_MS, PROTOCOL_VERSION, mcpToolName, type DeclaredMcpServer, type McpConsentAnswer, type McpServerState } from "./types";
import { McpError } from "./errors";
import type { Connection, ServerHandlers } from "./json-rpc";
import { StdioConnection } from "./transport-stdio";
import { HttpConnection } from "./transport-http";
import { MOH_VERSION } from "../workflow";

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

const REFUSED_CAPABILITIES: Record<string, "sampling" | "roots" | "elicitation"> = {
  "sampling/createMessage": "sampling",
  "roots/list": "roots",
  "elicitation/create": "elicitation",
};

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
          clientInfo: { name: "moh", version: MOH_VERSION },
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
