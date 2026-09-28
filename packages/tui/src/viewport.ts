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
export const COMPACT_COLS = 70;
export const WIDE_COLS = 110;

// ── Home session-list geometry (#112) ─────────────────────────────────────

/** Rows of the home recent-sessions list shown at once by default. */
export const HOME_LIST_DEFAULT = 5;
/** Upper bound for the configurable list height (user setting `homeListMax`). */
export const HOME_LIST_MAX = 10;
/** Small-screen floor: the home list never shrinks below this. */
export const HOME_LIST_MIN_VISIBLE = 3;
/** Rough row budget consumed by the home chrome (inline logo, search box,
 * footer). The big banner only appears at ≥30 rows where space is not
 * scarce, so it never adds to this budget. */
const HOME_CHROME_ROWS = 14;
/** Minimum terminal height for the big ASCII banner (#292); below it the
 * home falls back to the one-line `moh > — My Own Harness` logo. */
export const HOME_BANNER_MIN_ROWS = 30;
/** Below this many rows the home drops every filler row and hint line (#1023). */
export const HOME_TIGHT_ROWS = 15;
/** Below this many rows the home starts degrading padding and fillers (#1023). */
export const HOME_COMPACT_ROWS = 20;

/** #1023 vertical degradation tiers for the settled home frame. At small
 * terminal heights the home's own chrome (padding, blank spacers, hint
 * lines) pushed the frame past `rows`, so ink took the fullscreen path on
 * EVERY frame (clearTerminal + scrollback wipe + full reprint). The tiers
 * shed filler rows before content: the list shrinks first, then the
 * spacers, then the padding — the logo, the search box, the "New session"
 * row and the footer hint are the floor that always survives. */
export interface HomeVertical {
  /** Vertical padding around the whole home frame. */
  paddingY: number;
  /** Blank filler rows: one after the logo, two after the logo, one after
   * the search box, one before the footer (slots in that order). */
  spacers: number;
  /** Whether the low-value hint lines ("resume from another machine",
   * pin/rename/delete) render at all. */
  hints: boolean;
  /** Minimum visible list rows — 1 on degraded tiers (the cursor row must
   * stay visible), the usual floor 3 on roomy terminals. */
  listFloor: number;
}

/** Picks the home vertical tier for a terminal height. Pure, tested. */
export function homeVertical(rows: number): HomeVertical {
  if (rows < HOME_TIGHT_ROWS) return { paddingY: 0, spacers: 0, hints: false, listFloor: 1 };
  if (rows < HOME_COMPACT_ROWS) return { paddingY: 1, spacers: 1, hints: false, listFloor: 1 };
  return { paddingY: 2, spacers: 4, hints: true, listFloor: HOME_LIST_MIN_VISIBLE };
}

/** Whether the home shows the big ASCII banner (tall, non-compact terminals). */
export function homeBannerFits(v: Viewport): boolean {
  return widthClass(v) !== "compact" && v.rows >= HOME_BANNER_MIN_ROWS;
}

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

/**
 * Effective home-list height (#1023): the tier's floor first, then the
 * configured cap, shrunk by the terminal's remaining budget — never below
 * the floor, so the cursor row always stays visible.
 */
export function visibleListHeight(configured: number, rows: number): number {
  const floor = homeVertical(rows).listFloor;
  return Math.max(floor, Math.min(configured, rows - HOME_CHROME_ROWS));
}

// Session geometry is deliberately single-column (#183). Dashboard/sidebar
// and fixed transcript-window budgets were retired; MEASURE remains shared
// by Home, dialogs and the readable session column.

/** Fits optional status segments into a single terminal row. Required
 * segments are preserved; optional segments are dropped from the end and
 * the final segment is truncated rather than wrapped (#183). */
export function fitRow(segments: ReadonlyArray<{ text: string; optional?: boolean }>, budget: number): string[] {
  const limit = Math.max(1, budget);
  const keep = [...segments];
  const total = () => keep.reduce((sum, item) => sum + item.text.length + 1, -1);
  while (total() > limit) {
    let optional = -1;
    for (let i = keep.length - 1; i >= 0; i--) if (keep[i]!.optional) { optional = i; break; }
    if (optional < 0) break;
    keep.splice(optional, 1);
  }
  if (total() > limit && keep.length) {
    let longest = 0;
    for (let i = 1; i < keep.length; i++) if (keep[i]!.text.length > keep[longest]!.text.length) longest = i;
    keep[longest] = { text: keep[longest]!.text.slice(0, Math.max(1, keep[longest]!.text.length - (total() - limit))) };
  }
  return keep.map((item) => item.text);
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

/** #183 breakpoints: compact <70, regular 70–109, wide ≥110. */
export function widthClass(v: Viewport): WidthClass {
  if (v.columns < COMPACT_COLS) return "compact";
  return v.columns >= WIDE_COLS ? "wide" : "regular";
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

/**
 * Pre-wrap a paragraph into fixed-width lines (#1042): layout must be able
 * to count a wrapping block's rows before rendering it — a wrap="wrap" Text
 * decides its height at render time, after the budget is already spent.
 */
export function wrapLines(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      if (current.length === 0) current = word;
      else if (current.length + 1 + word.length <= limit) current += " " + word;
      else {
        out.push(current);
        current = word;
      }
      while (current.length > limit) {
        out.push(current.slice(0, limit));
        current = current.slice(limit);
      }
    }
    out.push(current);
  }
  return out;
}
