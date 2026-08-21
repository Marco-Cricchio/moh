/**
 * The seam between the core's blocking `onAskUser` callback and the TUI's
 * ask_user overlay (issue #70), mirroring PermissionGate: the core's turn
 * loop awaits `ask()`; the overlay resolves the pending question with the
 * user's answer (a choice or free text).
 */
import type { AskUserQuestion, AskUserResult } from "@moh/core";

interface Pending {
  question: AskUserQuestion;
  resolve: (answer: AskUserResult) => void;
}

/**
 * One pending question at a time (tool calls are sequential within the
 * turn loop). Subscribable for React.
 */
export class AskUserGate {
  #pending: Pending | null = null;
  #version = 0;
  readonly #listeners = new Set<() => void>();

  /** Snapshot of the question the overlay should render, if any. */
  get current(): AskUserQuestion | null {
    return this.#pending?.question ?? null;
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
  ask = (question: AskUserQuestion): Promise<AskUserResult> => {
    if (this.#pending) {
      // Overlapping asks must not happen (sequential gate); answer with the
      // suggested option defensively.
      return Promise.resolve({ choice: question.suggested });
    }
    return new Promise<AskUserResult>((resolve) => {
      this.#pending = { question, resolve };
      this.#emit();
    });
  };

  /** Settles the pending question; no-op when nothing is pending. */
  resolve(answer: AskUserResult): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    this.#emit();
    pending.resolve(answer);
  }
}
