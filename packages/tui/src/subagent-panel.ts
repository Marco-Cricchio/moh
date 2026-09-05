import { useEffect, useMemo, useRef, useState } from "react";
import { tailChildLog, type ChildTailLine } from "@moh/core";
import type { AgentEvent, AgentSession } from "@moh/core";
import { useSidebarState } from "./session-bridge";

/**
 * Subagent chips + live panel data (#497, vision note 25). Pure data:
 * tracks the session's subagent spawn/result events and polls each child
 * log through the core `tailChildLog` seam at a throttled cadence
 * (~3Hz). Rendering (chips, panel, peek) consumes this state.
 */

/** One tracked subagent, projected from the parent's event log. */
export interface TrackedSubagent {
  /** The parent-log callId of the `subagent_spawn` event. */
  callId: string;
  /** Display name (preset or model-chosen name). */
  name: string;
  /** Preset name, when the spawn declared one. */
  preset?: string;
  /** The child's own JSONL log — the tail seam's input. */
  log: string;
  status: "running" | "done" | "error" | "cancelled";
  /** Settled usage from `subagent_result` (tokens), when done. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Monotonic spawn time, for the panel's elapsed counter. */
  startedAt: number;
}

/** Projects the parent log into the ordered subagent list (#320 parity). */
export function trackSubagents(events: ReadonlyArray<AgentEvent>): TrackedSubagent[] {
  const byCallId = new Map<string, TrackedSubagent>();
  const list: TrackedSubagent[] = [];
  for (const event of events) {
    if (event.type === "subagent_spawn") {
      const item: TrackedSubagent = {
        callId: event.callId,
        name: event.name,
        ...(event.preset ? { preset: event.preset } : {}),
        log: event.log,
        status: "running",
        startedAt: Date.now(),
      };
      byCallId.set(event.callId, item);
      list.push(item);
    } else if (event.type === "subagent_result") {
      const item = byCallId.get(event.callId);
      if (item) {
        item.status = event.status;
        item.usage = event.usage;
      }
    }
  }
  return list;
}

/** Panel tail window: last N lines shown. */
export const PANEL_TAIL_LINES = 12;

/** One live view of a child: accumulated tail lines + activity. */
export interface SubagentTail {
  lines: ChildTailLine[];
  currentTool: string | null;
  /** Monotonic ms of the last observed log growth (drives `stalled`). */
  lastActivityAt: number | null;
}

const EMPTY_TAIL: SubagentTail = { lines: [], currentTool: null, lastActivityAt: null };

/** ~3Hz poll cadence (issue T2: 2–4Hz throttle; #183-era 33ms is for deltas). */
export const TAIL_POLL_MS = 350;

/**
 * Polls every tracked (or only the selected) child log at TAIL_POLL_MS and
 * coalesces results into one state per render cycle. Each log keeps its own
 * byte offset, so polling is incremental — never a full replay. Polling
 * stops when no subagent is running (settled views keep their frozen tail).
 */
export function useSubagentTails(subagents: TrackedSubagent[]): Map<string, SubagentTail> {
  const [tails, setTails] = useState<Map<string, SubagentTail>>(new Map());
  // Offsets and accumulated lines live in a ref: they persist across polls
  // without re-rendering, and keyed renders read only the snapshot state.
  const stateRef = useRef(new Map<string, { offset: number; tail: SubagentTail }>());

  useEffect(() => {
    if (subagents.length === 0) return;
    let stopped = false;

    const poll = async () => {
      const dirty = new Set<string>();
      for (const sub of subagents) {
        if (sub.status !== "running") continue;
        const entry = stateRef.current.get(sub.callId) ?? { offset: 0, tail: EMPTY_TAIL };
        const result = await tailChildLog(sub.log, entry.offset);
        if (stopped) return;
        let tail = entry.tail;
        if (result.lines.length > 0 || result.nextOffset !== entry.offset) {
          const lines = [...tail.lines, ...result.lines];
          tail = {
            lines: lines.length > PANEL_TAIL_LINES ? lines.slice(-PANEL_TAIL_LINES) : lines,
            currentTool: result.activity.currentTool ?? tail.currentTool,
            lastActivityAt: result.activity.lastActivityAt ?? tail.lastActivityAt,
          };
          dirty.add(sub.callId);
        }
        stateRef.current.set(sub.callId, { offset: result.nextOffset, tail });
      }
      if (!stopped && dirty.size > 0) {
        setTails((prev) => {
          const next = new Map(prev);
          for (const callId of dirty) {
            const entry = stateRef.current.get(callId);
            if (entry) next.set(callId, entry.tail);
          }
          return next;
        });
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), TAIL_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [subagents]);

  return tails;
}

/** Stalled marker threshold: no log growth for ~60s (pi watchdog pattern). */
export const STALLED_AFTER_MS = 60_000;

/** True when a running child has not appended to its log for a while. */
export function isStalled(sub: TrackedSubagent, tail: SubagentTail | undefined, now: number): boolean {
  if (sub.status !== "running") return false;
  if (!tail?.lastActivityAt) return false;
  return now - tail.lastActivityAt > STALLED_AFTER_MS;
}

/**
 * Count of subagents in the parent's log (App needs only the count for the
 * chip-cycle key handling; Chat renders the full chips). Lightweight: it
 * rides the coalesced sidebar subscription instead of a second one.
 */
export function useSubagentCount(session: AgentSession | null): number {
  const sidebar = useSidebarState(session);
  return useMemo(() => sidebar.activity.filter((item) => item.kind === "subagent").length, [sidebar]);
}

/** Chip state glyph: ◐ running, ⏸ stalled, ✓ ok, ✗ failed. */
export function subagentGlyph(sub: TrackedSubagent, tail: SubagentTail | undefined, now: number): string {
  if (sub.status === "done") return "✓";
  if (sub.status === "error" || sub.status === "cancelled") return "✗";
  return isStalled(sub, tail, now) ? "⏸" : "◐";
}

/** Below this column count the layout does not split — the panel degrades
 * to a volatile peek region above the footer (Claude Code peek pattern). */
export const PANEL_MIN_COLUMNS = 100;

/** Panel width: a percentage of the columns with sane bounds. */
export function panelWidth(columns: number): number {
  return Math.min(46, Math.max(28, Math.round(columns * 0.3)));
}

/** Human-readable elapsed ("1m07s"). */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Human-readable state label for the panel header ("running"/"stalled"/…). */
export function subagentStateLabel(sub: TrackedSubagent, tail: SubagentTail | undefined, now: number): string {
  if (sub.status !== "running") return sub.status;
  return isStalled(sub, tail, now) ? "stalled" : "running";
}

/** The panel's header line: name, elapsed, state, current tool. */
export function panelHeader(sub: TrackedSubagent, tail: SubagentTail | undefined, now: number): string {
  const glyph = subagentGlyph(sub, tail, now);
  const elapsed = formatElapsed(now - sub.startedAt);
  const state = subagentStateLabel(sub, tail, now);
  const tool = sub.status === "running" && tail?.currentTool ? ` · ${tail.currentTool}` : "";
  return `${glyph} ${sub.name} · ${elapsed} · ${state}${tool}`;
}

/** The settled panel's freeze line: outcome, tokens, pointer to transcript. */
export function panelFreezeLine(sub: TrackedSubagent): string {
  if (sub.status === "running") return "";
  const mark = sub.status === "done" ? "✓" : "✗";
  const tok = sub.usage
    ? ` · ${((sub.usage.inputTokens + sub.usage.outputTokens) / 1000).toFixed(1)}k tok`
    : "";
  return `${mark} ${sub.status}${tok} · result in transcript`;
}

