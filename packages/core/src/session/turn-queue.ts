import type { TurnResult } from "../types";

export interface TurnQueueOptions {
  /**
   * Runs one turn for the given text under the given controller. The
   * queue owns preemption; the executor owns the turn itself.
   */
  execute: (text: string, controller: AbortController) => Promise<TurnResult>;
  /**
   * Called when a turn settles (done/error/cancelled — including a turn
   * steered away), after the executor resolves. ADR-0011: the session
   * drops its turn-scoped skill prompt here.
   */
  onTurnSettled?: (result: TurnResult) => void;
  /**
   * Called when a queued send actually STARTS its turn (ADR-0011): the
   * attachment rides the queue item — a steering send that waited out a
   * cancelled turn applies its prompt here, not at enqueue time, so the
   * settling turn's cleanup cannot clear it first.
   */
  onTurnStart?: (attachment?: unknown) => void;
}

/**
 * The send queue + steering pump inside `AgentSession` (#92): pending
 * sends run front-first as soon as the session is idle. Preempt
 * semantics: a later send always preempts the running turn (its promise
 * resolves `{status: "cancelled"}`) and the steering message starts a
 * fresh turn as soon as the session is idle. Each send resolves with
 * the result of its own turn; there is no queued-only mode.
 */
export class TurnQueue {
  readonly #execute: TurnQueueOptions["execute"];
  readonly #onTurnSettled: TurnQueueOptions["onTurnSettled"];
  readonly #onTurnStart: TurnQueueOptions["onTurnStart"];
  #turn: Promise<TurnResult> | null = null;
  #controller: AbortController | null = null;
  /** Pending sends: front runs as soon as the session is idle. */
  readonly #queue: { text: string; resolve: (result: TurnResult) => void; attachment?: unknown }[] = [];

  constructor(options: TurnQueueOptions) {
    this.#execute = options.execute;
    this.#onTurnSettled = options.onTurnSettled;
    this.#onTurnStart = options.onTurnStart;
  }

  /** True while a turn is in flight (including one being steered away). */
  pending(): boolean {
    return this.#turn !== null;
  }

  /** Aborts the active turn; the cancelled path (and its `cancelled` event) lives in the loop. No-op if idle. */
  abort(): void {
    this.#controller?.abort();
  }

  /** Enqueues a user message; preempts the active turn if sends are waiting.
   * An optional opaque attachment (ADR-0011 skill prompt) is applied at
   * turn start via `onTurnStart`, surviving preemption and queueing. */
  send(text: string, attachment?: unknown): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      this.#queue.push({ text, resolve, attachment });
      this.#pump();
    });
  }

  /**
   * Starts the front-of-queue send when idle, or preempts the active
   * turn when sends are waiting. The finishing turn re-pumps, so a
   * steered session chains: cancelled -> steering user_message -> new turn.
   */
  #pump(): void {
    if (this.#turn !== null) {
      if (this.#queue.length > 0) this.#controller?.abort();
      return;
    }
    const item = this.#queue.shift();
    if (!item) return;
    if (item.attachment !== undefined) this.#onTurnStart?.(item.attachment);
    const controller = new AbortController();
    this.#controller = controller;
    const turn = this.#execute(item.text, controller);
    // Defensive: an unexpected rejection must still settle the caller's
    // promise instead of becoming an unhandled rejection.
    const guarded = turn.then(
      (result): TurnResult => result,
      (err): TurnResult => ({
        status: "error",
        reason: "internal",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    this.#turn = turn;
    void guarded.then((result) => {
      // Settled: chrome cleanup first (ADR-0011 — the skill prompt drops
      // before the next turn pumps), then free the slot and re-pump.
      this.#onTurnSettled?.(result);
      this.#turn = null;
      this.#controller = null;
      item.resolve(result);
      this.#pump();
    });
  }
}
