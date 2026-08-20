import type { AgentEvent, FinishReason, Message, Provider, TurnResult } from "./types";
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
  readonly #log: AgentEvent[] = [];
  readonly #messages: Message[] = [];
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  #controller: AbortController | null = null;

  constructor(config: SessionConfig) {
    this.#provider = config.provider;
    this.#maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
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
        try {
          for await (const event of this.#provider.stream(this.#messages, controller.signal)) {
            if (controller.signal.aborted) break;
            if (event.type === "text_delta") {
              assistantText += event.text;
              this.#append({ type: "assistant_delta", text: event.text });
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
          this.#pushAssistant(assistantText);
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

  #append(event: AgentEvent): void {
    this.#log.push(event);
    for (const listener of this.#listeners) listener(event);
  }
}
