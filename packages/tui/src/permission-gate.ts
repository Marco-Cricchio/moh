/**
 * The seam between the core's blocking `onPermissionRequest` callback and
 * the TUI's permission modal (issue #33). The core's turn loop awaits
 * `ask()`; the modal resolves the pending request with the user's answer.
 * "always" writes a session runtime rule here (bare-tool allow), so later
 * asks for the same tool never prompt — the TUI twin of the core's
 * runtime-rule tier, for client-initiated asks (Frontier claims) that
 * don't travel through a tool call.
 */
import { formatRule, splitCommandSegments } from "@moh/core";
import { truncate } from "./ui";
import { sanitizeForDisplay } from "./render-sanitize";

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
    // Mirrors the core's runtimeRuleFor("always") (SEC-04): one rule for a
    // single-segment command only — compounds are never flattened into a
    // never-matching token list, so "always" offers no preview there.
    const segments = splitCommandSegments(a.command);
    const rule = segments.length === 1 && segments[0]!.length > 0
      ? formatRule({ tier: "runtime", tool: "bash", effect: "allow", tokens: segments[0]! })
      : null;
    return { tool, args, detail: [`command: ${sanitizeForDisplay(a.command)}`], rulePreview: rule ? sanitizeForDisplay(rule) : null };
  }
  if (typeof a.path === "string") {
    return {
      tool,
      args,
      detail: [`path: ${sanitizeForDisplay(a.path)}`],
      rulePreview: sanitizeForDisplay(formatRule({ tier: "runtime", tool, effect: "allow", path: a.path })),
    };
  }
  // Tracker claims (#357): the issue id is the whole story — never raw JSON.
  if ((tool === "tracker_claim" || tool === "tracker_unclaim") && typeof a.id === "string") {
    return {
      tool,
      args,
      detail: [`issue: #${sanitizeForDisplay(a.id)}`],
      rulePreview: sanitizeForDisplay(formatRule({ tier: "runtime", tool, effect: "allow" })),
    };
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(args) ?? String(args);
  } catch {
    rendered = String(args);
  }
  rendered = truncate(sanitizeForDisplay(rendered), 200);
  return { tool, args, detail: rendered ? [rendered] : ["(no arguments)"], rulePreview: sanitizeForDisplay(formatRule({ tier: "runtime", tool, effect: "allow" })) };
}

/** ask_user (#70/#411): the first question is the summary; the answers
 * land in the tool_result output, so replay shows both. Handles both
 * the question-set shape and the legacy single-question args (replay of
 * pre-ADR-0019 sessions). */
export function askUserQuestionSummary(args: unknown): string | undefined {
  const a = (args ?? {}) as { question?: unknown; questions?: unknown };
  if (Array.isArray(a.questions)) {
    const q = (a.questions[0] as { question?: unknown } | undefined)?.question;
    if (typeof q === "string") return q;
  }
  return typeof a.question === "string" ? a.question : undefined;
}

/** One-line argument summary for tool lines (shared with the TUI chat). */
export function toolArgSummary(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.command === "string") return sanitizeForDisplay(a.command);
  if (typeof a.path === "string") return sanitizeForDisplay(a.path);
  const question = askUserQuestionSummary(args);
  if (question !== undefined) return sanitizeForDisplay(question);
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
  /** Session runtime rules written by "always" answers, keyed by the
   * canonical rule string (scoped: `bash:cmd prefix`, `write:path`, or
   * bare tool when the request carries no scoping arguments). */
  readonly #runtimeAllows = new Set<string>();
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
    // A runtime rule from a previous "always" short-circuits the prompt —
    // scoped: the rule this ask would write must match one already written.
    const view = describePermissionRequest(tool, args);
    if (view.rulePreview && this.#runtimeAllows.has(view.rulePreview)) {
      return Promise.resolve("yes");
    }
    return new Promise<PermissionAnswer>((resolve) => {
      this.#pending = { view, resolve };
      this.#emit();
    });
  };

  /** Settles the pending request; no-op when nothing is pending. */
  resolve(answer: PermissionAnswer): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    if (answer === "always" && pending.view.rulePreview) {
      this.#runtimeAllows.add(pending.view.rulePreview);
    }
    this.#emit();
    pending.resolve(answer);
  }
}
