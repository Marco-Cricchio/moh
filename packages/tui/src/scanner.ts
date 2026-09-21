/**
 * #876 / ADR-0042: the bottom bar's liveness beat.
 *
 * While a turn is live, row 1's left slot is a **scanner sweep**: a strip of
 * seven cells with one lit segment walking left→right and back, a couple of
 * cells of decaying trail behind it, and the unlit track visible the whole
 * time — the light bar of KITT, not a generic glyph cycle. The shape carries
 * the intensity (▮ ▯ ▫ ·), so the beat survives a monochrome terminal; the
 * bar adds the theme's true red on top.
 *
 * The module is pure geometry: `Chat` owns the clock (the ~90 ms tick, gated
 * on the active turn and never on stream events), this module owns what a
 * given tick looks like, and the frame leaves as one plain string — the shape
 * the `spinner` prop already carried, so no caller or test had to widen.
 */
import { ic } from "./icons";

/** Cells in the strip. Fixed: the sweep must read as a scan, not a blink. */
export const SCANNER_CELLS = 7;
/** Cells behind the light that keep a faded trail. */
const TRAIL_CELLS = 2;

/** The intensities the strip is made of, brightest first. One source of
 * truth for the frame and for the role the bar colours each cell with. */
const LEVELS = [
  { role: "head", glyph: "▮", ascii: "#" },
  { role: "trail", glyph: "▯", ascii: "=" },
  { role: "trail", glyph: "▫", ascii: "-" },
  { role: "track", glyph: "·", ascii: "." },
] as const;

export type ScannerRole = "head" | "trail" | "track";

/** The glyph of one cell, by how far behind the light it sits (0 = the
 * light). Read through `ic`, so an icon-free terminal gets the ASCII strip. */
export function scannerGlyph(distance: number): string {
  const level = LEVELS[Math.min(Math.max(distance, 0), LEVELS.length - 1)]!;
  return ic(level.glyph, level.ascii);
}

/**
 * What a rendered cell means, or `null` for any glyph that is not part of the
 * strip — the bar renders the pending slot generically, so a caller passing
 * the older braille frame still works (unrecognised glyphs simply keep the
 * slot's own colour).
 */
export function scannerRole(glyph: string): ScannerRole | null {
  return LEVELS.find((level) => level.glyph === glyph || level.ascii === glyph)?.role ?? null;
}

/**
 * The light's cell for a tick: ping-pong, one cell per tick, no wrap — it
 * walks to the right end, turns around and walks back (the original sweep
 * never jumped from one end to the other).
 */
export function scannerPosition(tick: number, cells: number = SCANNER_CELLS): number {
  if (cells <= 1) return 0;
  const span = 2 * cells - 2;
  const step = ((tick % span) + span) % span;
  return step < cells ? step : span - step;
}

/**
 * One frame as distances: `0` is the lit cell, `1..TRAIL_CELLS` the cells it
 * just passed, and everything else is unlit track. Exactly one cell is ever
 * `0`.
 */
export function scannerSweep(tick: number, cells: number = SCANNER_CELLS): number[] {
  const light = scannerPosition(tick, cells);
  const passed: number[] = [];
  for (let distance = 1; distance <= TRAIL_CELLS; distance++) {
    const cell = scannerPosition(tick - distance, cells);
    if (cell !== light && !passed.includes(cell)) passed.push(cell);
  }
  const track = Math.max(TRAIL_CELLS + 1, passed.length + 1);
  return Array.from({ length: cells }, (_, index) => {
    if (index === light) return 0;
    const behind = passed.indexOf(index);
    return behind < 0 ? track : behind + 1;
  });
}

/** One frame as the single string the `spinner` seam carries. */
export function scannerFrame(tick: number, cells: number = SCANNER_CELLS): string {
  return scannerSweep(tick, cells).map(scannerGlyph).join("");
}
