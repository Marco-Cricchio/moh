import type { AgentEvent } from "@moh/core";

/**
 * Pure projections feeding the right sidebar (#118, spec decision 6 /
 * delivery slice T6): Activity (recent tool calls + subagent state) and
 * Tokens (context usage from model_call usage). Pure: same events, same
 * sidebar state — the component only renders.
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
 * Projects the event log into sidebar state. Tool calls appear in order and
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

export interface ActivityWindow {
  visible: ActivityItem[];
  /** Rows hidden above the window (`↑ N more`). */
  hidden: number;
}

/**
 * Internal windowing for the Activity section: the most recent items that
 * fit in `budget` rows, everything older counted as hidden. The panel
 * itself never grows (#118 acceptance: windowing is internal only).
 */
export function activityWindow(items: ReadonlyArray<ActivityItem>, budget: number): ActivityWindow {
  const count = Math.max(0, Math.min(budget, items.length));
  return { visible: items.slice(items.length - count), hidden: items.length - count };
}

/** Fraction of the context window in use, capped at 1. */
export function contextFraction(contextIn: number, limit = CONTEXT_WINDOW_DEFAULT): number {
  return limit > 0 ? Math.min(1, Math.max(0, contextIn / limit)) : 0;
}

// ── panel geometry (fixed-height anchoring, #118) ─────────────────────────

/** Right-panel border rows (top + bottom). */
export const SIDEBAR_BORDER_ROWS = 2;
/** Slack row between the section stack and the bottom border: an exact fit
 * makes Ink's Yoga layout overflow the last row out of the panel. */
export const SIDEBAR_SLACK_ROWS = 1;
/** Workflow section: header + claimed/ready/blocked rows (fixed, bottom-anchored). */
export const WORKFLOW_ROWS = 4;
/** Tokens section: header + usage bar + counts (fixed, bottom-anchored). */
export const TOKENS_ROWS = 3;

/** Rows the Activity section gets for its items: everything between the
 * panel borders and the bottom-anchored sections, minus its own header.
 * Floored at 0 — with a tiny terminal the section simply renders nothing. */
export function sidebarActivityBudget(panelRows: number): number {
  return Math.max(0, panelRows - SIDEBAR_BORDER_ROWS - 1 - WORKFLOW_ROWS - TOKENS_ROWS);
}

/** The usage bar: `█` filled cells then `░`, exactly `width` cells. */
export function tokenBar(fraction: number, width: number): string {
  const w = Math.max(0, Math.trunc(width));
  const filled = Math.min(w, Math.max(0, Math.round(fraction * w)));
  return "█".repeat(filled) + "░".repeat(Math.max(0, w - filled));
}
