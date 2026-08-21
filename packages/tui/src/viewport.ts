import { useEffect, useState } from "react";
import { useStdout } from "ink";

/**
 * The viewport seam (issue #65): the single source of every geometric
 * decision in the TUI. Components never read `stdout.columns`/`stdout.rows`
 * directly and never hardcode percentage widths — they ask this module.
 *
 * Ink already re-renders on SIGWINCH; the explicit `resize` listener
 * forces a re-render for hosts where Ink misses one (test stubs, exotic
 * muxers), so `useViewport()` is live in both directions.
 */

export interface Viewport {
  columns: number;
  rows: number;
}

/** Widest the chat column ever gets: a readable measure, centered on wider terminals. */
export const MEASURE = 100;
/** Below this many columns the UI switches to compact styling (style guide §10 Q12). */
export const COMPACT_COLS = 60;

export type WidthClass = "compact" | "regular" | "wide";

/** Live terminal geometry; 80×24 fallback for non-tty hosts (tests, pipes). */
export function useViewport(): Viewport {
  const { stdout } = useStdout();
  const [, bump] = useState(0);
  useEffect(() => {
    const onResize = () => bump((x) => x + 1);
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);
  return { columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 };
}

/** Width classes: compact (< 60), regular (60…100), wide (> 100). */
export function widthClass(v: Viewport): WidthClass {
  if (v.columns < COMPACT_COLS) return "compact";
  return v.columns > MEASURE ? "wide" : "regular";
}

/** Content column width: the readable measure, or the whole terminal when narrower. */
export function contentWidth(v: Viewport): number {
  return Math.min(MEASURE, v.columns);
}

/**
 * Dialog width: ~62% of the terminal, clamped to [40, MEASURE] and never
 * wider than the terminal itself; the full terminal width when compact.
 */
export function dialogWidth(v: Viewport): number {
  if (widthClass(v) === "compact") return v.columns;
  return Math.max(40, Math.min(MEASURE, Math.round(v.columns * 0.62), v.columns));
}

export interface Windowed {
  start: number;
  count: number;
  /** Rows hidden above the window (`↑ N more`). */
  above: number;
  /** Rows hidden below the window (`↓ N more`). */
  below: number;
}

/**
 * Cursor-following scroll window for height-aware menus (#64): keeps the
 * cursor row visible inside `budget` rows and reports hidden-row counts
 * for the more-indicators. `budget` is clamped to at least one row.
 */
export function windowing(total: number, cursor: number, budget: number): Windowed {
  if (total <= 0) return { start: 0, count: 0, above: 0, below: 0 };
  const count = Math.max(1, Math.min(budget, total));
  const start = Math.min(Math.max(0, cursor - count + 1), Math.max(0, total - count));
  return { start, count, above: start, below: Math.max(0, total - start - count) };
}
