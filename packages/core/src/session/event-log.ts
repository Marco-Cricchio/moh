import type { AgentEvent, ReasoningStreamEvent } from "../types";

/** The dispatch surface EventLog needs from the extension runtime. */
export interface EventDispatcher {
  dispatchEvent(event: AgentEvent): Promise<AgentEvent[]>;
}

export interface EventLogOptions {
  /** Persistence sink: every appended (never seeded) event, in order. */
  sink?: (event: AgentEvent) => void;
  /** Extensions whose onEvent hooks receive appended events. */
  extensions?: EventDispatcher;
}

/**
 * The append-only event log (#89): in-memory storage, sink fan-out,
 * listener notification (the `events` async-iterator projection) and the
 * serial extension dispatch queue with reentrancy guard. `extension_failed`
 * events are terminal — dispatching them back to the hooks that produced
 * them would let a throwing hook loop forever.
 *
 * Seeded (resume) events are stored but never re-appended: the persisted
 * file already has them, so they never reach the sink or the hooks.
 */
export class EventLog {
  readonly #log: AgentEvent[] = [];
  readonly #sink: ((event: AgentEvent) => void) | undefined;
  readonly #extensions: EventDispatcher | undefined;
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  /** #253: live (ephemeral) reasoning listeners — notified without
   * storage, sink, or extension dispatch. The completed block still
   * lands as a persisted `reasoning` AgentEvent at call settlement. */
  readonly #liveListeners = new Set<(event: ReasoningStreamEvent) => void>();
  /** Serial queue of events pending onEvent dispatch (never dropped). */
  readonly #queue: AgentEvent[] = [];
  /** Reentrancy guard: events appended while hooks dispatch are not re-dispatched. */
  #dispatching = false;
  #dispatchTail: Promise<void> = Promise.resolve();

  constructor(options: EventLogOptions = {}) {
    this.#sink = options.sink;
    this.#extensions = options.extensions;
  }

  /** Stores resume events without sink, listeners or hook dispatch. */
  seed(events: Iterable<AgentEvent>): void {
    for (const event of events) this.#log.push(event);
  }

  append(event: AgentEvent): void {
    this.#log.push(event);
    this.#sink?.(event);
    for (const listener of this.#listeners) listener(event);
    if (this.#extensions && event.type !== "extension_failed") {
      this.#queue.push(event);
      this.#drain();
    }
  }

  /** Snapshot of the append-only log. */
  history(): AgentEvent[] {
    return [...this.#log];
  }

  /**
   * The live log array — for the host session's internal use only
   * (e.g. the memory runner's transcript windowing). Do not mutate.
   */
  live(): ReadonlyArray<AgentEvent> {
    return this.#log;
  }

  /** Async-iterator projection: replays history, then streams appends. */
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

  /** Notifies live listeners only: no storage, sink, or hooks (#253). */
  emitLive(event: ReasoningStreamEvent): void {
    for (const listener of this.#liveListeners) listener(event);
  }

  /** Subscribes to live (ephemeral) events; returns an unsubscribe fn. */
  onLive(listener: (event: ReasoningStreamEvent) => void): () => void {
    this.#liveListeners.add(listener);
    return () => this.#liveListeners.delete(listener);
  }

  /** Resolves when the dispatch queue is empty (no extensions: immediately). */
  idle(): Promise<void> {
    const check = (): Promise<void> =>
      this.#dispatching || this.#queue.length > 0 ? this.#dispatchTail.then(check) : Promise.resolve();
    return check();
  }

  #drain(): void {
    if (this.#dispatching || this.#queue.length === 0 || !this.#extensions) return;
    this.#dispatching = true;
    const event = this.#queue.shift()!;
    // Dispatch starts immediately (no extra microtask); the tail records the
    // in-flight chain so idle() can await the full drain.
    this.#dispatchTail = this.#extensions
      .dispatchEvent(event)
      .then((errors) => {
        for (const e of errors) this.append(e);
      })
      .finally(() => {
        this.#dispatching = false;
        this.#drain();
      });
  }
}
