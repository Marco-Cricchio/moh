import type { AgentEvent } from "@moh/core";

/**
 * Pure session-status projection. Activity remains useful for live phase
 * summaries; token usage and turn count feed the #183 bottom bar.
 */

/**
 * Assumed model context window for the usage bar. Providers do not expose
 * the limit, so the bar shows context-in against this default (200k is the
 * current floor for the models moh targets) — the percentage is an estimate,
 * shown, never persisted.
 */
export const CONTEXT_WINDOW_DEFAULT = 200_000;

/** One Activity row: a tool call (paired with its result) or a subagent. */
export type ActivityItem =
  | { kind: "tool"; name: string; detail: string; ok: boolean | null }
  | { kind: "subagent"; name: string; status: "running" | "done" | "error" | "cancelled" };

export interface SidebarTokens {
  /** Context in use: the input of the last model call (each call resends the whole context). */
  contextIn: number;
  /** Cumulative output tokens across all model calls. */
  totalOut: number;
  /** Number of model calls so far. */
  calls: number;
}

export interface SidebarState {
  activity: ActivityItem[];
  tokens: SidebarTokens;
  /** Turn count (user_message events) — drives the Workflow tracker refresh. */
  turnCount: number;
}

/**
 * Projects the event log into session status. Tool calls appear in order and
 * settle when their `tool_result` arrives (`ok` stays null while in
 * flight); subagents appear at spawn as `running` and settle on
 * `subagent_result`. Everything else is chrome.
 */
export function projectSidebar(events: ReadonlyArray<AgentEvent>): SidebarState {
  const activity: ActivityItem[] = [];
  const tools = new Map<string, ActivityItem & { kind: "tool" }>();
  const subs = new Map<string, ActivityItem & { kind: "subagent" }>();
  const tokens: SidebarTokens = { contextIn: 0, totalOut: 0, calls: 0 };
  let turnCount = 0;

  for (const event of events) {
    switch (event.type) {
      case "tool_call": {
        const item: ActivityItem & { kind: "tool" } = {
          kind: "tool",
          name: event.name,
          detail: detailOf(event.args),
          ok: null,
        };
        tools.set(event.callId, item);
        activity.push(item);
        break;
      }
      case "tool_result": {
        const item = tools.get(event.callId);
        if (item) item.ok = event.ok;
        break;
      }
      case "subagent_spawn": {
        const item: ActivityItem & { kind: "subagent" } = { kind: "subagent", name: event.name, status: "running" };
        subs.set(event.callId, item);
        activity.push(item);
        break;
      }
      case "subagent_result": {
        const item = subs.get(event.callId);
        if (item) item.status = event.status;
        break;
      }
      case "model_call":
        tokens.calls += 1;
        tokens.contextIn = event.usage.inputTokens;
        tokens.totalOut += event.usage.outputTokens;
        break;
      case "user_message":
        turnCount += 1;
        break;
      default:
        break;
    }
  }
  return { activity, tokens, turnCount };
}

/** Arg keys whose value makes the best one-line activity detail, tried in order. */
const DETAIL_KEYS = ["command", "path", "file", "pattern", "query", "url"];

/** One-line detail for a tool call: a known arg key if present, else the
 * first string value (arbitrary but stable for a given args object). */
function detailOf(args: unknown): string {
  if (args && typeof args === "object") {
    const rec = args as Record<string, unknown>;
    for (const key of DETAIL_KEYS) {
      const v = rec[key];
      if (typeof v === "string" && v) return v.split("\n")[0]!;
    }
    for (const v of Object.values(rec)) {
      if (typeof v === "string") return v.split("\n")[0]!;
    }
  }
  return "";
}

/** Fraction of the context window in use, capped at 1. */
export function contextFraction(contextIn: number, limit = CONTEXT_WINDOW_DEFAULT): number {
  return limit > 0 ? Math.min(1, Math.max(0, contextIn / limit)) : 0;
}
