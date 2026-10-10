/**
 * The glyph set, and the ASCII fallbacks the `Icons` toggle swaps in (the
 * `ic(glyph, ascii)` seam). Only some chrome reads it today — the rest of the
 * UI paints its glyphs literally — so turning icons off yields a partly-ASCII
 * bar. Finishing that wiring is the glyph-capability follow-up.
 *
 * Color capability is a separate question with its own seam (#880, color.ts):
 * `NO_COLOR` suppresses color, never glyphs.
 */
let icons = true;

export function setIcons(on: boolean): void {
  icons = on;
}

export function iconsEnabled(): boolean {
  return icons;
}

/** Picks the glyph or its ASCII fallback according to the icon toggle. */
export function ic(glyph: string, ascii: string): string {
  return icons ? glyph : ascii;
}

/** Braille spinner frames (cli-spinners dataset subset). */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** cli-spinners `sand` — footer subagent chip, native interval 80 ms (#1300). */
export const SAND_FRAMES = ["⠁", "⠂", "⠄", "⡀", "⡈", "⡐", "⡠", "⣀", "⣁", "⣂", "⣄", "⣌", "⣔", "⣤", "⣥", "⣦", "⣮", "⣶", "⣷", "⣿", "⡿", "⠿", "⢟", "⠟", "⡛", "⠛", "⠫", "⢋", "⠋", "⠍", "⡉", "⠉", "⠑", "⠡", "⢁"] as const;

/** cli-spinners `growVertical` — rail roster running member, native interval 120 ms (#1300). */
export const GROW_VERTICAL_FRAMES = ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"] as const;

/** Only running roster glyphs animate; Icons off uses a static ASCII dash. */
export function frameGlyph(base: string, frame: number, frames: readonly string[]): string {
  if (base.trim() !== "◐") return base;
  return base.replace("◐", icons ? frames[frame % frames.length]! : "-");
}
