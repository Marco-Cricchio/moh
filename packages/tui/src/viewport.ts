import { useEffect, useRef, useState } from "react";
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

// ── Home session-list geometry (#112) ─────────────────────────────────────

/** Rows of the home recent-sessions list shown at once by default. */
export const HOME_LIST_DEFAULT = 5;
/** Upper bound for the configurable list height (user setting `homeListMax`). */
export const HOME_LIST_MAX = 10;
/** Small-screen floor: the home list never shrinks below this. */
export const HOME_LIST_MIN_VISIBLE = 3;
/** Rough row budget consumed by the home chrome (logo, search box, footer). */
const HOME_CHROME_ROWS = 14;

/** Coerces a raw config value into a valid home-list height (3…10, default 5). */
export function clampHomeListMax(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return HOME_LIST_DEFAULT;
  return Math.min(HOME_LIST_MAX, Math.max(HOME_LIST_MIN_VISIBLE, Math.trunc(n)));
}

/** The cycling order the settings panel walks `homeListMax` through. */
export function homeListCycleValues(): number[] {
  return Array.from({ length: HOME_LIST_MAX - HOME_LIST_MIN_VISIBLE + 1 }, (_, i) => HOME_LIST_MIN_VISIBLE + i);
}

/** Effective home-list height: configured cap, shrunk by the terminal, floored at 3. */
export function visibleListHeight(configured: number, rows: number): number {
  return Math.max(HOME_LIST_MIN_VISIBLE, Math.min(configured, rows - HOME_CHROME_ROWS));
}

// ── Dashboard layout geometry (T1, issue #113) ────────────────────────────

/** Columns at which the session screen switches to the three-column dashboard. */
export const DASHBOARD_COLS = 90;
/** Header budget: title row + bottom border (prototype lesson: counts as 2 rows). */
export const HEADER_ROWS = 2;
/** Gap row between the panel row and the chip footer. */
export const GAP_ROWS = 1;
/** Chip footer budget. */
export const CHIP_ROWS = 1;

export type LayoutClass = "single" | "dashboard";

/** Which layout the session screen uses: dashboard from DASHBOARD_COLS up. */
export function layoutClass(v: Viewport): LayoutClass {
  return v.columns >= DASHBOARD_COLS ? "dashboard" : "single";
}

export interface SidebarWidths {
  /** Left menu sidebar width in columns. */
  menu: number;
  /** Right activity/workflow/tokens sidebar width in columns. */
  side: number;
}

/** Sidebar widths: compact near the threshold so the center column keeps room to breathe. */
export function sidebarWidths(v: Viewport): SidebarWidths {
  if (v.columns < DASHBOARD_COLS + 20) return { menu: 16, side: 24 };
  return { menu: 20, side: 30 };
}

/** Rows available to the panel row: the whole budget between header and chips. */
export function bodyRows(v: Viewport): number {
  return Math.max(1, v.rows - HEADER_ROWS - GAP_ROWS - CHIP_ROWS);
}

/** Center-column width: the terminal minus both sidebars and the two gap columns. */
export function centerWidth(v: Viewport): number {
  if (layoutClass(v) === "single") return v.columns;
  const { menu, side } = sidebarWidths(v);
  return v.columns - menu - side - 2;
}

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

/** The seam for resize *side effects* that need the live stdout stream
 * itself (e.g. repainting the screen): components never touch
 * `stdout.on("resize")` directly — they register here (rule 8). */
export function useStdoutResize(onResize: (stdout: NodeJS.WriteStream & { columns?: number; rows?: number }) => void): void {
  const { stdout } = useStdout();
  const ref = useRef(onResize);
  ref.current = onResize;
  useEffect(() => {
    if (!stdout) return;
    const handler = () => ref.current(stdout);
    stdout.on("resize", handler);
    return () => {
      stdout.off("resize", handler);
    };
  }, [stdout]);
}
