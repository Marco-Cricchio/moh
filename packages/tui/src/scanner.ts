/**
 * #876 / ADR-0042: the bottom bar's liveness beat.
 *
 * While a turn is live, row 1's left slot is a **scanner sweep**: a strip of
 * seven cells with one lit segment walking left→right and back, up to two
 * cells of decaying trail behind it, and the unlit track visible the whole
 * time — the light bar of KITT, not a generic glyph cycle. The shape carries
 * the intensity (▮ ▯ ▫ ·), so the beat survives a monochrome terminal; the
 * bar adds the theme's true red on top.
 *
 * The module is pure geometry and pure paint: `Chat` owns the clock (the
 * ~90 ms tick, gated on the active turn and never on stream events), this
 * module owns what a given tick looks like and how each cell is painted, and
 * the frame leaves as one plain string — the shape the `spinner` prop already
 * carried, so no caller or test had to widen.
 */
import { ic } from "./icons";

/** Cells in the strip. Fixed: the sweep must read as a scan, not a blink. */
export const SCANNER_CELLS = 7;
/** Cells behind the light that keep a faded trail. */
const TRAIL_CELLS = 2;
/** The unlit level: everything the light has not just passed. */
const UNLIT = 3;

/**
 * The four levels, brightest first — the light, two trail steps, the unlit
 * track — in the one place that carries the whole strip: the glyph, the ASCII
 * fallback, the role and the paint. The geometry below only produces indexes
 * into this table.
 */
const LEVELS = [
  { role: "head", glyph: "▮", ascii: "#", token: "err", bold: true, dim: false },
  { role: "trail", glyph: "▯", ascii: "=", token: "err", bold: false, dim: true },
  { role: "trail", glyph: "▫", ascii: "-", token: "err", bold: false, dim: true },
  { role: "track", glyph: "·", ascii: ".", token: "dim", bold: false, dim: false },
] as const;

export type ScannerLevel = 0 | 1 | 2 | 3;
export type ScannerRole = (typeof LEVELS)[number]["role"];

/** How one cell is painted: which theme token, and whether the light is
 * emphasised or the trail recedes. Tokens only — never a raw colour. */
export interface ScannerPaint {
  token: "err" | "dim";
  bold: boolean;
  dim: boolean;
}

/** The glyph of one level, read through `ic` so an icon-free terminal gets
 * the ASCII strip (`# = - .`). Read at frame time, never at import time. */
export function scannerGlyph(level: ScannerLevel): string {
  const cell = LEVELS[level]!;
  return ic(cell.glyph, cell.ascii);
}

/** The level a rendered cell stands for, or `null` for any glyph that is not
 * part of the strip (the phase word, an older braille frame). */
export function scannerLevelOf(glyph: string): ScannerLevel | null {
  const index = LEVELS.findIndex((cell) => cell.glyph === glyph || cell.ascii === glyph);
  return index < 0 ? null : (index as ScannerLevel);
}

/** How the bar paints one level. */
export function scannerPaint(level: ScannerLevel): ScannerPaint {
  const { token, bold, dim } = LEVELS[level]!;
  return { token, bold, dim };
}

/**
 * The light's cell for a tick: ping-pong, one cell per tick, no wrap — it
 * walks to the right end, turns around and walks back (the original sweep
 * never jumped from one end to the other).
 */
export function scannerPosition(tick: number): number {
  const span = 2 * SCANNER_CELLS - 2;
  const step = ((tick % span) + span) % span;
  return step < SCANNER_CELLS ? step : span - step;
}

/**
 * One frame as levels, one entry per cell: `0` is the lit cell, `1`/`2` the
 * cells it just passed (the more recent one brighter), `3` the unlit track.
 * Exactly one cell is ever `0`.
 *
 * The strip is defined by the tick alone, so the very first frame draws a
 * trail as if the light were arriving from the right — the state a round trip
 * reaches anyway, and one 90 ms frame at the start of a turn. Keeping the
 * geometry stateless is what makes the beat perfectly periodic.
 */
export function scannerSweep(tick: number): ScannerLevel[] {
  const light = scannerPosition(tick);
  const passed = new Map<number, ScannerLevel>();
  for (let step = 1 as ScannerLevel; step <= TRAIL_CELLS; step++) {
    const cell = scannerPosition(tick - step);
    if (cell !== light && !passed.has(cell)) passed.set(cell, step);
  }
  return Array.from({ length: SCANNER_CELLS }, (_, index): ScannerLevel => (index === light ? 0 : passed.get(index) ?? UNLIT));
}

/** One frame as the single string the `spinner` seam carries. */
export function scannerFrame(tick: number): string {
  return scannerSweep(tick).map(scannerGlyph).join("");
}

/**
 * Splits the pending left slot into the strip and whatever follows it (the
 * phase word). The strip is the **leading run** of strip glyphs, at most
 * `SCANNER_CELLS` long; anything else — the word itself, or a frame that is
 * not the scanner at all — is `rest`, and the bar renders it in the slot's
 * own colour. Nothing here looks at text *content*: a phase word like
 * `running web-fetch` can never be painted as cells, and neither can an
 * older braille frame.
 */
export function scannerStripSplit(text: string): { strip: { glyph: string; level: ScannerLevel }[]; rest: string } {
  const glyphs = Array.from(text);
  const strip: { glyph: string; level: ScannerLevel }[] = [];
  let index = 0;
  while (index < glyphs.length && strip.length < SCANNER_CELLS) {
    const glyph = glyphs[index]!;
    const level = scannerLevelOf(glyph);
    if (level === null) break;
    strip.push({ glyph, level });
    index += 1;
  }
  return { strip, rest: glyphs.slice(index).join("") };
}
