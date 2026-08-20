/**
 * Nerd Font glyph with ASCII fallback. Capability detection and the `i`
 * toggle are follow-ups (see docs/tui-style-guide.md §11); callers get the
 * glyph set until then.
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
