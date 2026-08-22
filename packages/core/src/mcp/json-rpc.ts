import { McpError, type McpErrorKind } from "./errors";

export interface ServerHandlers {
  /** Server -> client request; may be refused (capabilities we do not support). */
  onRequest(method: string, id: number | string): void;
  onCrash(): void;
}

export interface Connection {
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
export abstract class JsonRpcConnection implements Connection {
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
