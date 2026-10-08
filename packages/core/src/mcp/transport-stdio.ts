import { McpError } from "./errors";
import { JsonRpcConnection, type ServerHandlers } from "./json-rpc";

/** #1254: an unconsumed partial line (a server that never emits a newline)
 * is capped here — the connection ends crashed rather than growing the
 * buffer unboundedly. Same philosophy as the HTTP response cap. */
export const MCP_MAX_LINE_BYTES = 10 * 1024 * 1024;

/**
 * Environment deliberately exposed to a stdio MCP server. Do not inherit the
 * launching process: it commonly holds provider credentials unrelated to MCP.
 */
function minimalEnvironment(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "TERM"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

export class StdioConnection extends JsonRpcConnection {
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
        env: minimalEnvironment(opts.env),
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
        if (buf.length > MCP_MAX_LINE_BYTES) {
          // #1254: kill the server so a hostile peer cannot keep feeding
          // bytes, fail pending requests with the typed reason, then land
          // in the ordinary crashed state.
          this.#proc.kill();
          this.failPending(new McpError("crashed", `MCP stdio partial line exceeded the ${Math.round(MCP_MAX_LINE_BYTES / (1024 * 1024))} MB buffer cap`));
          break;
        }
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
