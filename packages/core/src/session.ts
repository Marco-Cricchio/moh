import type { AgentEvent, FinishReason, Message, Provider, Tool, ToolCall, ToolContext, TurnResult } from "./types";
import { SCHEMA_VERSION } from "./types";
import type { SessionConfig } from "./index";

const DEFAULT_MAX_ITERATIONS = 50;

/**
 * One conversation instance. The append-only event log *is* the session:
 * streaming, history and (later) persistence are projections of it.
 */
export class AgentSession {
  readonly #provider: Provider;
  readonly #maxIterations: number;
  readonly #tools: Record<string, Tool>;
  readonly #cwd: string;
  readonly #log: AgentEvent[] = [];
  readonly #messages: Message[] = [];
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  #controller: AbortController | null = null;

  constructor(config: SessionConfig) {
    this.#provider = config.provider;
    this.#maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.#tools = config.tools ?? {};
    this.#cwd = config.cwd ?? process.cwd();
    this.#append({ type: "session_start", schemaVersion: SCHEMA_VERSION });
  }

  /** Append-only event log, replayable in memory. */
  get events(): AsyncIterable<AgentEvent> {
    let cursor = 0;
    let notify: (() => void) | null = null;
    const listener = () => notify?.();
    this.#listeners.add(listener);
    let done = false;
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (cursor < self.#log.length) return { value: self.#log[cursor++]!, done: false };
            if (done) return { value: undefined as never, done: true };
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
            if (cursor < self.#log.length) return { value: self.#log[cursor++]!, done: false };
            return { value: undefined as never, done: true };
          },
          async return() {
            self.#listeners.delete(listener);
            done = true;
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }

  /** True while a turn is in flight. */
  pending(): boolean {
    return this.#controller !== null;
  }

  /** Snapshot of the append-only event log. */
  history(): AgentEvent[] {
    return [...this.#log];
  }

  /** Cancels the active turn; appends a `cancelled` event. No-op if idle. */
  abort(): void {
    this.#controller?.abort();
  }

  /** Tools registered on this session. */
  get tools(): Record<string, Tool> {
    return this.#tools;
  }

  async send(text: string): Promise<TurnResult> {
    if (this.pending()) throw new Error("a turn is already pending");
    const controller = new AbortController();
    this.#controller = controller;
    try {
      this.#append({ type: "user_message", text });
      this.#messages.push({ role: "user", parts: [{ kind: "text", text }] });

      let iterations = 0;
      let assistantText = "";
      let finishReason: FinishReason | null = null;
      while (finishReason !== "stop") {
        if (iterations >= this.#maxIterations) {
          this.#append({ type: "error", reason: "max_iterations", message: `iteration cap of ${this.#maxIterations} reached` });
          return { status: "error", reason: "max_iterations", message: "iteration cap reached" };
        }
        iterations += 1;
        assistantText = "";
        finishReason = null;
        const toolCalls: ToolCall[] = [];
        try {
          for await (const event of this.#provider.stream(this.#messages, controller.signal)) {
            if (controller.signal.aborted) break;
            if (event.type === "text_delta") {
              assistantText += event.text;
              this.#append({ type: "assistant_delta", text: event.text });
            } else if (event.type === "tool_calls") {
              toolCalls.push(...event.calls);
            } else if (event.type === "finish") {
              finishReason = event.reason;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) break;
          const reason = err instanceof Error && "kind" in err ? String((err as any).kind) : "provider_failure";
          const message = err instanceof Error ? err.message : String(err);
          this.#append({ type: "error", reason, message });
          return { status: "error", reason, message };
        }
        if (finishReason === null) {
          // Stream ended without a finish event (e.g. aborted mid-stream).
          break;
        }
        if (finishReason !== "stop") {
          this.#messages.push({
            role: "assistant",
            parts: [
              ...(assistantText ? [{ kind: "text" as const, text: assistantText }] : []),
              ...toolCalls.map((c) => ({ kind: "tool_call" as const, ...c })),
            ],
          });
          const outcome = await this.#runTools(toolCalls, controller.signal);
          if (outcome === "aborted") break;
        }
      }

      if (controller.signal.aborted) {
        this.#append({ type: "cancelled" });
        return { status: "cancelled" };
      }
      this.#pushAssistant(assistantText);
      this.#append({ type: "done" });
      return { status: "done" };
    } finally {
      this.#controller = null;
    }
  }

  #pushAssistant(text: string): void {
    this.#messages.push({ role: "assistant", parts: [{ kind: "text", text }] });
  }

  /**
   * Runs same-turn tool calls in parallel (Promise.allSettled), appends
   * tool_call/tool_result events in completion order, and feeds results
   * back as a user message the model sees for self-correction.
   * Returns "aborted" if the turn was cancelled mid-execution.
   */
  async #runTools(calls: ToolCall[], signal: AbortSignal): Promise<"ok" | "aborted"> {
    if (calls.length === 0) return "ok";
    for (const call of calls) {
      this.#append({ type: "tool_call", callId: call.callId, name: call.name, args: call.args });
    }
    // Append each tool_result the moment its promise settles, so the log
    // reflects completion order; collect parts in that same order.
    const resultParts: Message["parts"] = [];
    await Promise.allSettled(
      calls.map(async (call) => {
        const result = await this.#executeTool(call, signal);
        this.#append({ type: "tool_result", callId: result.callId, ok: result.ok, output: result.output });
        resultParts.push({ kind: "tool_result", callId: result.callId, ok: result.ok, output: result.output });
      }),
    );
    this.#messages.push({ role: "user", parts: resultParts });
    return signal.aborted ? "aborted" : "ok";
  }

  async #executeTool(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{ callId: string; ok: boolean; output: string }> {
    const tool = this.#tools[call.name];
    if (!tool) {
      return { callId: call.callId, ok: false, output: `unknown tool: ${call.name}` };
    }
    let args: unknown = call.args;
    if (tool.inputSchema) {
      const parsed = tool.inputSchema.safeParse(call.args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return { callId: call.callId, ok: false, output: `invalid arguments for ${call.name}: ${issues}` };
      }
      args = parsed.data;
    }
    const ctx: ToolContext = {
      signal,
      cwd: this.#cwd,
      onProgress: () => {},
    };
    try {
      const output = await tool.execute(args, ctx);
      return { callId: call.callId, ok: true, output: String(output) };
    } catch (err) {
      return {
        callId: call.callId,
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  #append(event: AgentEvent): void {
    this.#log.push(event);
    for (const listener of this.#listeners) listener(event);
  }
}
