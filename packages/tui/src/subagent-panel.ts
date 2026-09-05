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
  /** Name rendered in chrome: `name`, or `N name` when names collide. */
  displayName?: string;
  /** Preset name, when the spawn declared one. */
  preset?: string;
  /** The child's own JSONL log — the tail seam's input. */
  log: string;
  status: "running" | "done" | "error" | "cancelled";
  /** Settled usage from `subagent_result` (tokens), when done. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Wall-clock settlement time: drives the 30s ephemeral chrome grace. */
  settledAt?: number;
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
        item.settledAt = Date.now();
      }
    }
  }
  // Same-name children need an ordinal to be distinguishable in the footer
  // and panel selector. Unique names stay uncluttered.
  const totals = new Map<string, number>();
  for (const sub of list) totals.set(sub.name, (totals.get(sub.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const sub of list) {
    const ordinal = (seen.get(sub.name) ?? 0) + 1;
    seen.set(sub.name, ordinal);
    if ((totals.get(sub.name) ?? 0) > 1) sub.displayName = `${ordinal} ${sub.name}`;
  }
  return list;
}

/** Panel tail window: last N *rendered* rows. Assistant deltas are
 * coalesced below, then each is rendered truncate-only, so this is a real
 * visual cap rather than an event-count cap. */
export const PANEL_TAIL_LINES = 4;
/** Settled chrome is intentionally ephemeral: its static transcript block
 * remains permanent, but the chip and peek leave after this grace window. */
export const SETTLED_SUBAGENT_GRACE_MS = 30_000;

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
  // Monotonic line-id counter: tail lines must keep unique React keys
  // across polls (a per-chunk counter would restart at 1 every poll and
  // collide with the already-rendered lines).
  const lineIdRef = useRef(0);

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
          const lines = coalesceTailLines(
            tail.lines,
            result.lines.map((line) => ({ ...line, id: ++lineIdRef.current })),
          );
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
  // Parent projections are rebuilt on each render. Depend on a stable
  // identity signature, not the array object, otherwise each tail repaint
  // tears down the interval before its next 3Hz tick can fire.
  }, [subagents.map((sub) => `${sub.callId}:${sub.status}:${sub.log}`).join("|")]);

  return tails;
}

/** Coalesces consecutive assistant-delta tail lines into one evolving
 * preview. `childTailLine` marks them with `· `; tool/status lines retain
 * their own rows. The newest id wins, so React preserves one identity for
 * the live prose preview rather than rendering a word per streaming event. */
export function coalesceTailLines(previous: ChildTailLine[], appended: ChildTailLine[]): ChildTailLine[] {
  const out = [...previous];
  for (const line of appended) {
    if (line.text.startsWith("· ") && out.at(-1)?.text.startsWith("· ")) {
      const last = out[out.length - 1]!;
      const prior = last.text.slice(2);
      const next = line.text.slice(2);
      // Preserve the provider's exact whitespace. A delta may split inside
      // a word (`Luna` + `nasialzò`), so inventing a word boundary here
      // makes prose *less* faithful; childTailLine keeps whitespace intact.
      out[out.length - 1] = { id: line.id, text: `· ${prior}${next}` };
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Stalled marker threshold: no log growth for ~60s (pi watchdog pattern). */
export const STALLED_AFTER_MS = 60_000;

/**
 * Makes settled child chrome ephemeral without touching the parent log or
 * the static transcript projection. Settlement has no persisted wall-clock
 * timestamp, so the local observation time starts the 30s grace window.
 */
export function useVisibleSubagents(all: TrackedSubagent[]): TrackedSubagent[] {
  const settledAt = useRef(new Map<string, number>());
  const [, rerender] = useState(0);
  const now = Date.now();
  for (const sub of all) {
    if (sub.status === "running") settledAt.current.delete(sub.callId);
    else if (!settledAt.current.has(sub.callId)) settledAt.current.set(sub.callId, now);
  }
  useEffect(() => {
    const deadlines = all
      .filter((sub) => sub.status !== "running")
      .map((sub) => (settledAt.current.get(sub.callId) ?? now) + SETTLED_SUBAGENT_GRACE_MS - Date.now())
      .filter((ms) => ms > 0);
    if (deadlines.length === 0) return;
    const timer = setTimeout(() => rerender((n) => n + 1), Math.min(...deadlines));
    return () => clearTimeout(timer);
  }, [all]);
  return all.map((sub) => ({ ...sub, ...(settledAt.current.get(sub.callId) ? { settledAt: settledAt.current.get(sub.callId) } : {}) }))
    .filter((sub) => sub.status === "running" || now - sub.settledAt! < SETTLED_SUBAGENT_GRACE_MS);
}

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
  // Keep App's keyboard projection in step with Chat's 30s settled-chip
  // grace. Sidebar has no callId, but activity order is append-only, so an
  // ordinal index is stable for the lifetime of this mounted session.
  const sidebar = useSidebarState(session);
  const settledAt = useRef(new Map<number, number>());
  const [, rerender] = useState(0);
  const now = Date.now();
  const subs = sidebar.activity.filter((item) => item.kind === "subagent");
  for (const [index, sub] of subs.entries()) {
    if (sub.status === "running") settledAt.current.delete(index);
    else if (!settledAt.current.has(index)) settledAt.current.set(index, now);
  }
  useEffect(() => {
    const deadlines = subs.map((sub, index) => sub.status === "running" ? 0 : (settledAt.current.get(index) ?? now) + SETTLED_SUBAGENT_GRACE_MS - Date.now()).filter((ms) => ms > 0);
    if (deadlines.length === 0) return;
    const timer = setTimeout(() => rerender((n) => n + 1), Math.min(...deadlines));
    return () => clearTimeout(timer);
  }, [subs.length, subs.map((sub) => sub.status).join(",")]);
  return subs.filter((sub, index) => sub.status === "running" || now - (settledAt.current.get(index) ?? now) < SETTLED_SUBAGENT_GRACE_MS).length;
}

/** Chip state glyph: ◐ running, ⏸ stalled, ✓ ok, ✗ failed. */
export function subagentGlyph(sub: TrackedSubagent, tail: SubagentTail | undefined, now: number): string {
  if (sub.status === "done") return "✓";
  if (sub.status === "error" || sub.status === "cancelled") return "✗";
  return isStalled(sub, tail, now) ? "⏸" : "◐";
}

/** (Deprecated) former split-layout thresholds — kept only because the
 * owner's revision removed the split entirely; the peek is now the only
 * layout. Kept exported for one release so clients importing them don't
 * break; do not use in new code. */
export const PANEL_MIN_COLUMNS = 100;

/** (Deprecated) former split-layout width; unused since the split was
 * removed. Kept exported for one release. */
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
  return `${glyph} ${sub.displayName ?? sub.name} · ${elapsed} · ${state}${tool}`;
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

