/**
 * The seam between the core's blocking `onPermissionRequest` callback and
 * the TUI's permission modal (issue #33). The core's turn loop awaits
 * `ask()`; the modal resolves the pending request with the user's answer.
 * "always" is handled inside the core (runtime rule + auditable event).
 */
import { formatRule, splitCommandSegments } from "@moh/core";
import { truncate } from "./ui";

export type PermissionAnswer = "yes" | "always" | "no";

export interface PermissionRequestView {
  tool: string;
  args: unknown;
  /** Human-oriented detail lines (command segments, path, raw args). */
  detail: string[];
  /** Rule the "always" answer would write, when persistable. */
  rulePreview: string | null;
}

/** Formats one request for display. Pure — unit-testable. */
export function describePermissionRequest(tool: string, args: unknown): PermissionRequestView {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "bash" && typeof a.command === "string") {
    const tokens = splitCommandSegments(a.command).flat();
    const rule = tokens.length > 0 ? formatRule({ tier: "runtime", tool: "bash", effect: "allow", tokens }) : null;
    return { tool, args, detail: [`command: ${a.command}`], rulePreview: rule };
  }
  if (typeof a.path === "string") {
    return {
      tool,
      args,
      detail: [`path: ${a.path}`],
      rulePreview: formatRule({ tier: "runtime", tool, effect: "allow", path: a.path }),
    };
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(args) ?? String(args);
  } catch {
    rendered = String(args);
  }
  rendered = truncate(rendered, 200);
  return { tool, args, detail: rendered ? [rendered] : ["(no arguments)"], rulePreview: formatRule({ tier: "runtime", tool, effect: "allow" }) };
}

/** One-line argument summary for tool lines (shared with the TUI chat). */
export function toolArgSummary(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  // ask_user (#70): the question is the summary; the answer lands in the
  // tool_result output, so replay shows both.
  if (typeof a.question === "string") return a.question;
  return "";
}

interface Pending {
  view: PermissionRequestView;
  resolve: (answer: PermissionAnswer) => void;
}

/**
 * One pending permission request at a time (the core asks per tool call,
 * sequentially within a turn's gate). Subscribable for React.
 */
export class PermissionGate {
  #pending: Pending | null = null;
  #version = 0;
  readonly #listeners = new Set<() => void>();

  /** Snapshot of the request the modal should render, if any. */
  get current(): PermissionRequestView | null {
    return this.#pending?.view ?? null;
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

  /** The callback handed to `createSession` as `onPermissionRequest`. */
  ask = (tool: string, args: unknown): Promise<PermissionAnswer> => {
    if (this.#pending) {
      // Overlapping asks must not happen (sequential gate); deny defensively.
      return Promise.resolve("no");
    }
    return new Promise<PermissionAnswer>((resolve) => {
      this.#pending = { view: describePermissionRequest(tool, args), resolve };
      this.#emit();
    });
  };

  /** Settles the pending request; no-op when nothing is pending. */
  resolve(answer: PermissionAnswer): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    this.#emit();
    pending.resolve(answer);
  }
}
