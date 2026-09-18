/**
 * The seam between the core's blocking `onConfirmTurn` callback and the
 * TUI's confirmation modal (ADR-0033 §4, apiVersion 1.4): the core's turn
 * loop awaits `ask()` before a turn that an extension flagged, and the
 * modal settles it with "send anyway" or "cancel". Mirrors PermissionGate.
 *
 * Cancelling is not a denial of anything: the turn simply never happens —
 * the message goes back to the composer and nothing is logged about it.
 * The gate hands the text back so the caller can restore the draft.
 */
import type { ConfirmTurnRequest, TurnConfirmOutcome } from "@moh/core";

export interface PendingConfirm {
  readonly request: ConfirmTurnRequest;
}

interface Pending extends PendingConfirm {
  resolve: (outcome: TurnConfirmOutcome) => void;
}

/**
 * One pending confirmation at a time (a send is one turn). Subscribable
 * for React.
 */
export class ConfirmTurnGate {
  #pending: Pending | null = null;
  #version = 0;
  readonly #listeners = new Set<() => void>();
  /** Called with the message a cancel hands back, so the composer can
   * restore it: nothing else knows what the user typed. */
  #onCancelled: ((text: string) => void) | undefined;

  /** Snapshot of the request the modal should render, if any. */
  get current(): PendingConfirm | null {
    return this.#pending ? { request: this.#pending.request } : null;
  }

  /** Bumped on every state change; use with useSyncExternalStore. */
  get version(): number {
    return this.#version;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): number => this.#version;

  /** Where a cancelled confirmation returns its text (the composer). */
  onCancelled(handler: (text: string) => void): void {
    this.#onCancelled = handler;
  }

  #emit(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  /** The callback handed to the session as `onConfirmTurn`. */
  ask = (request: ConfirmTurnRequest): Promise<TurnConfirmOutcome> => {
    if (this.#pending) {
      // Two confirmations cannot overlap (one turn at a time). Refuse
      // rather than answer for the user: a silent "send" would defeat the
      // guardrail that asked.
      return Promise.resolve("refuse");
    }
    return new Promise<TurnConfirmOutcome>((resolve) => {
      this.#pending = { request, resolve };
      this.#emit();
    });
  };

  /** Settles the pending confirmation; no-op when nothing is pending. */
  resolve(outcome: TurnConfirmOutcome): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    this.#emit();
    if (outcome === "cancel") this.#onCancelled?.(pending.request.text);
    pending.resolve(outcome);
  }
}
