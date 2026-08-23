import React from "react";
import { Box, Text } from "ink";
import type { Marked } from "marked";
import { useTheme } from "./themes";
import type { Theme } from "./themes";
import type { TurnView } from "./turns";
import { closeOpenFences, wrapRenderedLines } from "./markdown";
import { toolArgSummary } from "./permission-gate";
import { sanitizeLine, truncate } from "./ui";

/**
 * The chat window (issue #117, spec decisions 4–5): the session transcript
 * rendered INSIDE the chat box as a fixed-height, bottom-anchored window of
 * flat lines — colored speaker labels (` you` accent / ` moh` purple, tool
 * lines dim with ✓/✗), prototype-faithful, NOT the MsgBox stack. Keyboard
 * scroll moves a window offset; the terminal itself never scrolls during a
 * session. Streaming re-renders never fight the offset: while the anchor
 * follows the tail new lines arrive at the bottom; once the user scrolls
 * up, the visible window stays put as content grows below it.
 */

/** Line budget kept in memory for in-session scrollback; older history = resume. */
export const CHAT_WINDOW_BUFFER = 1000;

/** One rendered transcript line: plain text plus its semantic tone. */
export interface ChatLine {
  text: string;
  tone: "fg" | "accent" | "purple" | "dim" | "warn";
}

/** Greedy word wrap against the chat-box width; explicit newlines honored. */
export function wrapWords(s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (cur.length === 0) cur = word;
      else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
      else {
        out.push(cur);
        cur = word;
      }
    }
    out.push(cur);
  }
  return out;
}

export interface TurnLineOptions {
  /** ctrl+d detail: inline (truncated) tool output under each call. */
  detail?: boolean;
  /** Spinner frame while `turn.phase === "streaming"`. */
  spinner?: string;
  /** Live hint after the spinner (e.g. "streaming… · esc to steer"). */
  streamingNote?: string;
}

/** Projects one turn into flat transcript lines (pure). */
export function turnLines(turn: TurnView, wrapW: number, opts: TurnLineOptions = {}): ChatLine[] {
  const lines: ChatLine[] = [];
  lines.push({ text: " you", tone: "accent" });
  for (const l of wrapWords(turn.user, wrapW)) lines.push({ text: ` ${l}`, tone: "fg" });
  lines.push({ text: "", tone: "fg" });

  for (const call of turn.toolCalls) {
    const mark = call.ok === null ? "…" : call.ok ? "✓" : "✗";
    const args = toolArgSummary(call.args);
    const out = call.ok === true && call.output ? ` ${truncate(sanitizeLine(call.output.split("\n")[0]!), 60)}` : "";
    lines.push({ text: ` ${mark} ${call.name}${args ? ` ${args}` : ""}${out}`, tone: "dim" });
    if (opts.detail && call.output) {
      for (const l of call.output.split("\n").slice(0, 15)) {
        lines.push({ text: `   ${truncate(sanitizeLine(l), 200)}`, tone: "dim" });
      }
    }
  }

  const streaming = turn.phase === "streaming";
  const reply = turn.reply.trim();
  if (reply || turn.phase === "error" || streaming) {
    lines.push({ text: " moh", tone: "purple" });
    for (const l of wrapWords(reply, wrapW)) lines.push({ text: ` ${l}`, tone: "fg" });
    if (streaming) {
      lines.push({ text: ` ${opts.spinner ?? "·"} ${opts.streamingNote ?? "streaming…"}`, tone: "dim" });
    } else {
      if (turn.phase === "error") {
        lines.push({ text: ` ⚠ ${turn.error?.reason ?? "error"}: ${turn.error?.message ?? ""}`, tone: "warn" });
      }
      if (turn.phase === "cancelled") lines.push({ text: " · stopped ·", tone: "dim" });
      lines.push({ text: "", tone: "fg" });
    }
  }
  return lines;
}

// ── scroll math ───────────────────────────────────────────────────────────

/** Most lines that can sit above the window: everything fits → 0. */
export function maxScrollOffset(total: number, height: number): number {
  return Math.max(0, total - Math.max(1, height));
}

/** Keeps an offset inside [0, maxScrollOffset] (shrink-safe). */
export function clampScrollOffset(offset: number, total: number, height: number): number {
  return Math.min(Math.max(0, offset), maxScrollOffset(total, height));
}

/**
 * The scroll anchor: `follow` pins the window to the tail (streaming adds
 * lines at the bottom, the view tracks them); otherwise `offset` is the
 * index of the first visible line and new content grows below the window
 * without moving it.
 */
export interface ScrollAnchor {
  follow: boolean;
  offset: number;
}

/** Effective first-visible-line index for the current content size. */
export function resolveOffset(anchor: ScrollAnchor, total: number, height: number): number {
  return anchor.follow ? maxScrollOffset(total, height) : clampScrollOffset(anchor.offset, total, height);
}

/**
 * Scrolls by `delta` lines (negative = older). Reaching the bottom resumes
 * follow-tail; scrolling up from the bottom pauses it.
 */
export function scrollAnchor(anchor: ScrollAnchor, delta: number, total: number, height: number): ScrollAnchor {
  const max = maxScrollOffset(total, height);
  const cur = anchor.follow ? max : clampScrollOffset(anchor.offset, total, height);
  const next = Math.min(Math.max(0, cur + delta), max);
  return { follow: next >= max, offset: next };
}

// ── component ─────────────────────────────────────────────────────────────

export interface ChatWindowProps {
  lines: ReadonlyArray<ChatLine>;
  /** Fixed window height in rows (the box never grows with content). */
  height: number;
  /** First visible line index (already resolved by the caller). */
  offset: number;
}

const TONE: Record<ChatLine["tone"], keyof Theme> = {
  fg: "fg",
  accent: "accent",
  purple: "purple",
  dim: "dim",
  warn: "warn",
};

/** The fixed-height transcript window: renders exactly `height` rows. */
export function ChatWindow({ lines, height, offset }: ChatWindowProps) {
  const theme = useTheme();
  const h = Math.max(1, height);
  const start = clampScrollOffset(offset, lines.length, h);
  const visible: ChatLine[] = [];
  for (let i = start; i < start + h; i++) visible.push(lines[i] ?? { text: "", tone: "fg" });
  return (
    <Box flexDirection="column" height={h} overflow="hidden" flexShrink={0}>
      {visible.map((line, i) => (
        <Text key={`${start + i}`} color={theme[TONE[line.tone]]} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
