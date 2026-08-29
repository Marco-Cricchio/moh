/** #300: wall-clock ledger for tool calls. The TUI must not duplicate the
 * core's timing decisions: elapsed comes from when the call's block
 * appeared live, final duration from the call→result ledger here. The
 * event log stays the sole source of truth (Principle 2) — this ledger is
 * presentation-only state, rebuilt from the live event stream, and never
 * persisted or merged into it. */
export interface ToolTiming {
  /** Wall-clock ms at the moment the tool_call event arrived. */
  at: number;
  /** Final call→result duration in ms, once the tool_result arrived. */
  durationMs?: number;
}

/** Ledger state: one entry per callId seen in the live stream. */
export type ToolTimings = Map<string, ToolTiming>;

/** Ledger scan: one Date.now() sample before the loop, timestamps per
 * event, duration when a result pairs with its call. A stray result
 * without its call is ignored (nothing to time). */
export function scanToolTimings(events: ReadonlyArray<{ type: string; callId?: string }>): ToolTimings {
  const timings: ToolTimings = new Map();
  const now = Date.now();
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "tool_call" && typeof event.callId === "string") {
      if (!timings.has(event.callId)) timings.set(event.callId, { at: now });
      continue;
    }
    if (event.type === "tool_result" && typeof event.callId === "string") {
      const timing = timings.get(event.callId);
      if (timing && timing.durationMs === undefined) timing.durationMs = Math.max(0, now - timing.at);
    }
  }
  return timings;
}

/** Merge step for incremental rescans: carries prior timings over so a
 * completed call keeps its recorded duration even as the live window
 * grows. Unmatched prior entries (a result without a call in this window)
 * keep their duration and original arrival. */
export function mergeToolTimings(prior: ToolTimings, fresh: ToolTimings): ToolTimings {
  const merged: ToolTimings = new Map(prior);
  for (const [callId, timing] of fresh) {
    const old = merged.get(callId);
    merged.set(callId, old && old.durationMs !== undefined && timing.durationMs === undefined ? old : timing);
  }
  return merged;
}

/**
 * #300 format decision 2: `12s` under a minute, `1m 05s` above (zero
 * padded); whole minutes alone once there are no leftover seconds
 * (`5m`). Sub-second durations render as `0s` — a per-second live timer
 * has no finer granularity to show.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * #300 format decision 2: limits always read as whole minutes when they
 * divide evenly (the common case — 30s stays `30s`, 600000ms is `10m`);
 * otherwise the seconds form keeps exact meaning.
 */
export function formatTimeout(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total % 60 === 0) return `${total / 60}m`;
  return formatDuration(ms);
}
