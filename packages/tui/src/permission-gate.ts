/**
 * The seam between the core's blocking `onPermissionRequest` callback and
 * the TUI's permission modal (issue #33). The core's turn loop awaits
 * `ask()`; the modal resolves the pending request with the user's answer.
 * "always" writes a session runtime rule here (bare-tool allow), so later
 * asks for the same tool never prompt — the TUI twin of the core's
 * runtime-rule tier, for client-initiated asks (Frontier claims) that
 * don't travel through a tool call.
 */
import { formatRule, splitCommandSegments, type PermissionAskContext } from "@moh/core";
import { truncate } from "./ui";
import { sanitizeForDisplay } from "./render-sanitize";

export type PermissionAnswer = "yes" | "always" | "always_for_site" | "no";

/** #834: the tool id of an extension's enable consent. It is never a tool
 * call: the id exists so the ask renders as a question about code (and can
 * never write a rule). */
export const EXTENSION_CONSENT_TOOL = "extension";

export interface PermissionRequestView {
  tool: string;
  args: unknown;
  /** Human-oriented detail lines (command segments, path, raw args). */
  detail: string[];
  /** Rule the "always" answer would write, when persistable. */
  rulePreview: string | null;
  /**
   * ADR-0031: set when an extension escalated this call through its hook's
   * `ask` outcome. The prompt then offers yes/no only — no "always", so a
   * false positive cannot disarm the filter that raised it — and the
   * extension's own reason becomes its label.
   */
  extensionAsk?: { extension?: string; reason?: string };
}

/** Formats one request for display. Pure — unit-testable.
 * `context` is present only for an extension ask (ADR-0031). */
export function describePermissionRequest(
  tool: string,
  args: unknown,
  context?: PermissionAskContext,
): PermissionRequestView {
  const extensionAsk =
    context?.source === "extension"
      ? { ...(context.extension ? { extension: context.extension } : {}), ...(context.reason ? { reason: context.reason } : {}) }
      : undefined;
  const view = describeOwnRequest(tool, args);
  if (!extensionAsk) return view;
  // An extension ask never writes a rule: the prompt must offer no
  // "always" at all, so there is no rule preview to render either.
  return { ...view, rulePreview: null, extensionAsk };
}

/** The tool's own ask (rules/mode): what the "always" answer would write. */
function describeOwnRequest(tool: string, args: unknown): PermissionRequestView {
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
  // #775 (ADR-0029): browser asks render action + element description +
  // domain from the snapshot, and the "always for this site" rule they
  // would write (session-scoped `browser:<action> <origin>/**`).
  if (tool === "browser" && typeof a.action === "string") {
    const detail: string[] = [];
    const element = typeof a.elementDescription === "string" ? a.elementDescription : `[${
      typeof a.ref === "string" ? `ref ${a.ref}` : "page"
    }]`;
    let host = "";
    if (typeof a.pageUrl === "string") {
      try {
        host = new URL(a.pageUrl).host;
      } catch { /* rendered without a domain */
      }
    }
    detail.push(`${a.action} ${element}${host ? ` on ${host}` : ""}`);
    if (typeof a.pageUrl === "string" && host) {
      let origin: string;
      try {
        origin = new URL(a.pageUrl).origin;
      } catch {
        origin = "";
      }
      if (origin) {
        const rule = formatRule({ tier: "runtime", tool: `browser:${a.action}`, effect: "allow", url: `${origin}/**` });
        detail.push(`site: ${sanitizeForDisplay(rule)}`);
        return { tool, args, detail: detail.map(sanitizeForDisplay), rulePreview: sanitizeForDisplay(rule) };
      }
    }
    return { tool, args, detail: detail.map(sanitizeForDisplay), rulePreview: null };
  }
  // #834: the consent question for enabling a *client-loaded extension*.
  // It is not a tool call, so it renders as the extension's own question
  // (name, version, source path, and the fact that there is no sandbox) and
  // it can never write a rule: an extension is enabled once, or not at all.
  if (tool === EXTENSION_CONSENT_TOOL && (typeof a.name === "string" || typeof a.file === "string")) {
    const detail: string[] = [];
    if (typeof a.name === "string") detail.push(`name: ${sanitizeForDisplay(a.name)}`);
    if (typeof a.version === "string") detail.push(`version: ${sanitizeForDisplay(a.version)}`);
    if (typeof a.file === "string") detail.push(`source: ${sanitizeForDisplay(a.file)}`);
    if (typeof a.hash === "string") detail.push(`sha256: ${sanitizeForDisplay(a.hash)}`);
    // #834 (security): a first-time file is asked about BEFORE it is imported
    // — the question has to come before the code runs — so it has made no
    // claims to show. Saying so is the honest prompt, not a defect.
    if (typeof a.name !== "string") detail.push("name/version: not stated yet (the file is asked about before it runs)");
    detail.push("no sandbox: it runs with moh's own privileges");
    return { tool, args, detail, rulePreview: null };
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
  ask = (tool: string, args: unknown, context?: PermissionAskContext): Promise<PermissionAnswer> => {
    if (this.#pending) {
      // Overlapping asks must not happen (sequential gate); deny defensively.
      return Promise.resolve("no");
    }
    // A runtime rule from a previous "always" short-circuits the prompt —
    // scoped: the rule this ask would write must match one already written.
    // An extension ask never has a rule to match (ADR-0031).
    const view = describePermissionRequest(tool, args, context);
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
    // #775: on a browser ask, "always" and "always for this site" both
    // record the site-scoped rule — there is no tool-wide browser rule.
    // ADR-0031: an extension ask has no rulePreview, so it can never record
    // one even if a client answers "always".
    if ((answer === "always" || answer === "always_for_site") && pending.view.rulePreview) {
      this.#runtimeAllows.add(pending.view.rulePreview);
    }
    this.#emit();
    pending.resolve(answer);
  }
}
