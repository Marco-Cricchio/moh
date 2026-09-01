/**
 * The seam between the core's blocking `onAskUser` callback and the TUI's
 * ask_user UI (issue #411 / ADR-0019): the core's turn loop awaits
 * `ask()` with a **question set** (1–4 questions); the UI collects ALL
 * answers — or an explicit cancellation — and releases the turn with one
 * settled result. Mirrors PermissionGate.
 */
import type { AskUserQuestionSet, AskUserSetResult } from "@moh/core";

interface Pending {
  set: AskUserQuestionSet;
  resolve: (result: AskUserSetResult) => void;
}

/**
 * One pending question set at a time (interactive tools serialize within
 * a parallel batch, #223). Subscribable for React.
 */
export class AskUserGate {
  #pending: Pending | null = null;
  #version = 0;
  readonly #listeners = new Set<() => void>();

  /** Snapshot of the question set the UI should render, if any. */
  get current(): AskUserQuestionSet | null {
    return this.#pending?.set ?? null;
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

  #emit(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  /** The callback handed to `createSession` as `onAskUser`. */
  ask = (set: AskUserQuestionSet): Promise<AskUserSetResult> => {
    if (this.#pending) {
      // Overlapping asks must not happen (sequential gate). Reject rather
      // than silently answer — #68 forbids silent fallbacks; the tool call
      // fails, the agent sees the error and self-corrects.
      return Promise.reject(new Error("ask_user: a question set is already pending"));
    }
    return new Promise<AskUserSetResult>((resolve) => {
      this.#pending = { set, resolve };
      this.#emit();
    });
  };

  /** Settles the pending set; no-op when nothing is pending. */
  resolve(result: AskUserSetResult): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    this.#emit();
    pending.resolve(result);
  }
}
