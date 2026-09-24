/**
 * #767: the single-session analysis report — one read-only pass over one
 * session event log, the sibling of the cross-session telemetry
 * aggregator (same pricing conventions, same metadata-only discipline:
 * tokens, counts, durations, error kinds — never message content, tool
 * outputs, or reasoning). Runs on the active-path projection like every
 * other read seam: stats reflect the branch the session's head points at,
 * while tree stats describe the full topology. Returns an explicit
 * `{ error }` on an unreadable, corrupt or empty log — never throws,
 * never a silent fallback (ADR-0005 discipline).
 */
import type { AgentEvent } from "./types";
import type { LocalUsageRow } from "./quota/local";
import { aggregateLocalUsage, type BillingPlanResolver } from "./quota/local";
import { activePath } from "./session/event-log";
import { ENCODING } from "./session/ulid";
import { SessionStore, sessionTree } from "./session-store";

/** Per-model usage for this session's active branch (failed calls
 * excluded, same convention as the cross-session aggregator). */
export type SessionModelRow = LocalUsageRow;

/** Tool health for this session's active branch. */
export interface SessionToolRow {
  tool: string;
  calls: number;
  ok: number;
  fail: number;
  /** Failed results grouped by structured `errorKind` (absent kinds leave
   * the map short of `fail`, same as the cross-session aggregator). */
  errorKinds?: Record<string, number>;
}

/** Permission chrome counts for the active branch. */
export interface SessionPermissionStats {
  requested: number;
  granted: number;
  denied: number;
}

/** The session's shape: turn-level and chrome-event counts. */
export interface SessionShapeStats {
  /** Turn tails on the active path: `done` + `error` + `cancelled`. */
  turns: number;
  done: number;
  error: number;
  cancelled: number;
  userMessages: number;
  compactions: number;
  compactionFailures: number;
  modelSwitches: number;
  fallbacks: number;
}

/** Tree topology stats (full tree, not just the active branch). */
export interface SessionTreeStats {
  branchCount: number;
  /** Number of turns on the active path. */
  activePathTurns: number;
  bookmarks: number;
}

/** The structured single-session report consumed by the CLI and the TUI. */
export interface SessionAnalysisReport {
  models: SessionModelRow[];
  tools: SessionToolRow[];
  permissions: SessionPermissionStats;
  shape: SessionShapeStats;
  tree: SessionTreeStats;
  /** Wall time: first → last event on the active path, from ULID
   * identity (0 when undatable). */
  wallTimeMs: number;
  /** Sum of paired call→result tool durations on the active path. */
  toolDurationMs: number;
  /** The session file the report was computed from. */
  file: string;
}

/** ULID time component (first 10 Crockford chars) → epoch ms, or null. */
function ulidTimeMs(id: string | undefined): number | null {
  if (!id || id.length < 10) return null;
  let ms = 0;
  for (let i = 0; i < 10; i++) {
    const v = ENCODING.indexOf(id[i]!);
    if (v < 0) return null;
    ms = ms * 32 + v;
  }
  return ms;
}

/**
 * Analyzes one session file: usage, tool health, permissions, shape and
 * tree stats over the active branch (tree stats over the full topology).
 * Read-only: opens through the same store seam as every other reader and
 * disposes immediately (the open registry must never record a view).
 */
export function analyzeSession(
  file: string,
  options: { planFor?: BillingPlanResolver } = {},
): SessionAnalysisReport | { error: string } {
  let events: AgentEvent[];
  try {
    const store = SessionStore.open(file);
    try {
      events = store.load();
    } finally {
      store.dispose();
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (events.length === 0) return { error: `empty session log ${file}` };

  const path = activePath(events);

  // Usage: the shared local rollup, restricted to the active path.
  const models = aggregateLocalUsage(path, options.planFor ? { planFor: options.planFor } : {});

  // Tool pairing on the active path: callId → tool name + call time.
  const callByCallId = new Map<string, { name: string; ms: number | null }>();
  for (const event of path) {
    if (event.type === "tool_call") callByCallId.set(event.callId, { name: event.name, ms: ulidTimeMs(event.id) });
  }

  const toolRows = new Map<string, SessionToolRow>();
  const permissions: SessionPermissionStats = { requested: 0, granted: 0, denied: 0 };
  const shape: SessionShapeStats = {
    turns: 0,
    done: 0,
    error: 0,
    cancelled: 0,
    userMessages: 0,
    compactions: 0,
    compactionFailures: 0,
    modelSwitches: 0,
    fallbacks: 0,
  };
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  let toolDurationMs = 0;

  for (const event of path) {
    const ms = ulidTimeMs(event.id);
    if (ms !== null) {
      firstMs = firstMs ?? ms;
      lastMs = ms;
    }
    if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
      shape[event.type] += 1;
      shape.turns += 1;
    }
    if (event.type === "user_message") shape.userMessages += 1;
    if (event.type === "compaction") shape.compactions += 1;
    if (event.type === "compaction_failed") shape.compactionFailures += 1;
    if (event.type === "model_switched") shape.modelSwitches += 1;
    if (event.type === "fallback") shape.fallbacks += 1;
    if (event.type === "permission_requested") permissions.requested += 1;
    if (event.type === "permission_granted") permissions.granted += 1;
    if (event.type === "permission_denied") permissions.denied += 1;
    if (event.type === "tool_call") {
      const row = toolRows.get(event.name) ?? { tool: event.name, calls: 0, ok: 0, fail: 0 };
      row.calls += 1;
      toolRows.set(event.name, row);
    }
    if (event.type === "tool_result") {
      const call = callByCallId.get(event.callId);
      const row = call ? toolRows.get(call.name) : undefined;
      if (row) {
        if (event.ok) row.ok += 1;
        else {
          row.fail += 1;
          if (event.errorKind !== undefined) {
            row.errorKinds ??= {};
            row.errorKinds[event.errorKind] = (row.errorKinds[event.errorKind] ?? 0) + 1;
          }
        }
        const resultMs = ulidTimeMs(event.id);
        if (call?.ms !== null && call?.ms !== undefined && resultMs !== null) {
          toolDurationMs += Math.max(0, resultMs - call.ms);
        }
      }
    }
  }

  // Tree stats over the full topology (the active-branch projection is
  // certified by `activePath`; the branch count needs every event).
  let branchCount = 0;
  let activePathTurns = 0;
  let bookmarks = 0;
  const tree = sessionTree(file);
  if (!("error" in tree)) {
    activePathTurns = tree.nodes.filter((n) => n.onActivePath && n.kind === "turn").length;
    bookmarks = tree.nodes.filter((n) => n.bookmark !== undefined).length;
  }
  branchCount = countBranches(events);

  return {
    models,
    tools: [...toolRows.values()].sort((a, b) => b.calls - a.calls),
    permissions,
    shape,
    tree: { branchCount, activePathTurns, bookmarks },
    wallTimeMs: firstMs !== null && lastMs !== null ? Math.max(0, lastMs - firstMs) : 0,
    toolDurationMs,
    file,
  };
}

/** Distinct root→tip turn paths: a turn tail is a branch tip when no
 * later turn opens from it (no `user_message` references it as parent).
 * Forks always open from the tail they diverge from, so untipped tails
 * count exactly the leaves of the turn tree (≥1). */
function countBranches(events: readonly AgentEvent[]): number {
  const parents = new Set<string>();
  for (const e of events) {
    if (e.type === "user_message" && e.parentId !== undefined) parents.add(e.parentId);
  }
  let tips = 0;
  for (const e of events) {
    if ((e.type === "done" || e.type === "error" || e.type === "cancelled") && e.id !== undefined && !parents.has(e.id)) {
      tips += 1;
    }
  }
  return Math.max(1, tips);
}
