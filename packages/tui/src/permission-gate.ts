/**
 * The seam between the core's blocking `onPermissionRequest` callback and
 * the TUI's permission modal (issue #33). The core's turn loop awaits
 * `ask()`; the modal resolves the pending request with the user's answer.
 * "always" is handled inside the core (runtime rule + auditable event).
 */
import { splitCommandSegments } from "@moh/core";
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
    const segments = splitCommandSegments(a.command);
    const rule = segments.length > 0 ? `bash: ${segments.map((s) => s.join(" ")).join(" ; ")} → allow` : null;
    return { tool, args, detail: [`command: ${a.command}`], rulePreview: rule };
  }
  if (typeof a.path === "string") {
    return {
      tool,
      args,
      detail: [`path: ${a.path}`],
      rulePreview: `${tool} on ${a.path} → allow this session`,
    };
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(args) ?? String(args);
  } catch {
    rendered = String(args);
  }
  rendered = truncate(rendered, 200);
  return { tool, args, detail: rendered ? [rendered] : ["(no arguments)"], rulePreview: `${tool} → allow` };
}

/** One-line argument summary for tool lines (shared with the TUI chat). */
export function toolArgSummary(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
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
