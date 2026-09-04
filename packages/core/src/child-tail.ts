import { open } from "node:fs/promises";
import type { AgentEvent } from "./types";

/**
 * The child-log tail seam (#497, ADR-0004 reopening): an offset-based,
 * allocation-bounded read of a running child session's JSONL log, plus an
 * activity snapshot derived from it. Core-neutral — the seam is data; no
 * TUI concepts (panels, chips, throttling) leak in. Clients poll it on
 * their own cadence and render however they like.
 */

/** One renderable line of the child's tail: short, sanitized, chrome-only. */
export interface ChildTailLine {
  /** Stable per-line key for keyed rendering. */
  id: number;
  /** Short summary, e.g. `● bash · git status` or `✓ done`. */
  text: string;
}

/** Current activity of a running child, derived from its log. */
export interface ChildActivity {
  /** The tool currently in flight, when one is. */
  currentTool: string | null;
  /** Monotonic ms timestamp of the last event appended to the log. */
  lastActivityAt: number | null;
}

/** Bounded result of one `tailChildLog` poll. */
export interface ChildTailResult {
  /** Lines starting at the requested offset. */
  lines: ChildTailLine[];
  /** Offset to pass as `from` on the next poll (bytes). */
  nextOffset: number;
  /** Number of events appended to the log so far (across all polls). */
  eventCount: number;
  /** Current activity snapshot (also returned standalone by `childActivity`). */
  activity: ChildActivity;
}

/**
 * Event kinds that produce a tail line; everything else is chrome the
 * panel does not need (deltas, permissions, memory, handoff, …).
 */
const TAILED_EVENTS = new Set([
  "user_message",
  "assistant_delta",
  "tool_call",
  "tool_result",
  "done",
  "error",
  "cancelled",
]);

function shortArgSummary(event: Extract<AgentEvent, { type: "tool_call" }>): string {
  const args = event.args as Record<string, unknown> | null | undefined;
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "name"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      const flat = value.replace(/\s+/g, " ").trim();
      return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
    }
  }
  return "";
}

/**
 * Projects one appended child event into at most one tail line.
 * Exported for tests; clients render `text` verbatim (already bounded).
 */
export function childTailLine(id: number, event: AgentEvent): ChildTailLine | null {
  if (!TAILED_EVENTS.has(event.type)) return null;
  switch (event.type) {
    case "user_message":
      return { id, text: "▸ task" };
    case "assistant_delta": {
      const words = firstWords(event.text, 8);
      return words ? { id, text: `· ${words}` } : null;
    }
    case "tool_call": {
      const summary = shortArgSummary(event);
      return { id, text: `● ${event.name}${summary ? ` · ${summary}` : ""}` };
    }
    case "tool_result":
      return { id, text: event.ok ? "✓ done" : `✗ failed · ${firstWords(event.output, 5)}` };
    case "done":
      return { id, text: "✓ done" };
    case "error":
      return { id, text: `✗ error · ${firstWords(event.message, 5)}` };
    case "cancelled":
      return { id, text: "✗ cancelled" };
    default:
      return null;
  }
}

function firstWords(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const words = flat.split(" ").slice(0, max).join(" ");
  return words.length > 60 ? `${words.slice(0, 59)}…` : words;
}

/** Hard cap on one poll's returned lines: never allocate without bound. */
export const CHILD_TAIL_MAX_LINES = 200;

/**
 * Reads the child log from byte offset `from`, returning the projected
 * tail lines and the next offset. Tolerates a truncated trailing line
 * (the child may be mid-append): the offset only advances past complete
 * lines. A missing/unreadable file yields an empty result at the same
 * offset — the caller decides what a vanished log means.
 */
export async function tailChildLog(logPath: string, from = 0): Promise<ChildTailResult> {
  const activity = { currentTool: null as string | null, lastActivityAt: null as number | null };
  let eventCount = 0;
  const lines: ChildTailLine[] = [];

  let handle;
  try {
    handle = await open(logPath, "r");
  } catch {
    return { lines, nextOffset: from, eventCount: 0, activity };
  }

  try {
    const { size } = await handle.stat();
    if (size <= from) return { lines, nextOffset: from, eventCount: 0, activity };
    const buffer = Buffer.alloc(Math.min(size - from, 8 * 1024 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    // Only complete lines count: drop a trailing partial line and keep the
    // offset at its start so the next poll re-reads it whole.
    let end = bytesRead;
    if (end > 0 && buffer[end - 1] !== 0x0a) {
      const lastNewline = buffer.lastIndexOf(0x0a, end - 1);
      end = lastNewline + 1;
    }
    if (end === 0) return { lines, nextOffset: from, eventCount: 0, activity };

    let cursor = 0;
    let id = 0;
    while (cursor < end) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline === -1 || newline >= end) break;
      const raw = buffer.subarray(cursor, newline).toString("utf8").trim();
      cursor = newline + 1;
      if (raw === "") continue;
      id += 1;
      eventCount += 1;
      try {
        const event = JSON.parse(raw) as AgentEvent;
        const line = childTailLine(id, event);
        if (line) lines.push(line);
        if (event.type === "tool_call") activity.currentTool = event.name;
        activity.lastActivityAt = Date.now();
      } catch {
        // A corrupt line is skipped, not fatal.
      }
    }
    const bounded = lines.length > CHILD_TAIL_MAX_LINES ? lines.slice(-CHILD_TAIL_MAX_LINES) : lines;
    return { lines: bounded, nextOffset: from + cursor, eventCount, activity };
  } finally {
    await handle.close();
  }
}
