/**
 * #880: the one place that decides whether moh may put **color** on the wire.
 *
 * `NO_COLOR` (no-color.org) is a capability, not a preference: when the
 * variable is present and non-empty a program should not emit ANSI color.
 * It says nothing about glyphs (that is the separate `icons` toggle) and
 * nothing about attributes — bold, dim and italic are not colors, so a
 * color-free session keeps its emphasis and only loses its hues.
 *
 * Two things reach the terminal with color, and both read this module:
 *
 * 1. Ink's `<Text color>` / `borderColor` / `backgroundColor` — fed by
 *    `paintable()` (see themes.ts), so a disabled run hands Ink `undefined`
 *    and its `colorize` returns the string untouched.
 * 2. The escapes written by hand where a string is built outside Ink — the
 *    markdown renderer (inline code, headings, syntax highlighting), the
 *    quota modal's table cells and the preview box's line truncation. They
 *    take their color-opening escape from here. Syntax highlighting is the
 *    awkward one: cli-highlight paints roles our theme map does not cover
 *    with its own 16-color theme, which no projection can reach, so a
 *    color-free run skips the highlight entirely (a highlight *is* color).
 *
 * 3. `selectionStyle()`: the cursor idiom (`bg` on `accent`) is two colors
 *    that vanish together, leaving a row you cannot find. It degrades to
 *    inverse video — the attribute that says the same thing, and one
 *    `NO_COLOR` keeps.
 *
 * Closing escapes (`\x1b[39m`, `\x1b[0m`) stay where they are: a reset adds
 * no color, and gating them would change nothing on screen.
 */

/** True when color may be emitted. The spec's semantics, not a truthiness
 * check: an empty `NO_COLOR` means "not set". Read per call — the child
 * environment is fixed at launch, and a per-call read keeps tests honest. */
export function colorEnabled(): boolean {
  const value = process.env.NO_COLOR;
  return value === undefined || value === "";
}

/** A hex color as six digits, or `null` for anything else: an unparsable
 * token must paint nothing rather than an escape full of `NaN`. */
const sixDigits = (hex: string | undefined): string | null => {
  if (!hex) return null;
  const match = /^#(?:([0-9a-f])([0-9a-f])([0-9a-f])|([0-9a-f]{6}))$/i.exec(hex);
  if (match === null) return null;
  return match[4] ?? `${match[1]}${match[1]}${match[2]}${match[2]}${match[3]}${match[3]}`;
};

/** Truecolor foreground escape for one hex color, or `""` when the terminal
 * must not receive color codes (and when there is no color to paint). */
export function fgTruecolor(hex: string | undefined): string {
  const digits = sixDigits(hex);
  if (digits === null || !colorEnabled()) return "";
  const rgb = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)).join(";");
  return `\x1b[38;2;${rgb}m`;
}

/** ANSI-256 foreground escape: for plain-string cells (cli-table3 builds its
 * own text, so Ink cannot style a cell on its own). The hex → 256
 * approximation lives here rather than at the call site, so the table and
 * everything else answer to the same switch. */
export function fgAnsi256(hex: string | undefined): string {
  const digits = sixDigits(hex);
  if (digits === null || !colorEnabled()) return "";
  const n = parseInt(digits, 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const index = 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
  return `\x1b[38;5;${index}m`;
}

/**
 * The selection idiom — `bg` on `accent`, the inverse-video look used by every
 * list cursor in the UI (settings rows, pickers, wizards, onboarding).
 *
 * #880: both tokens vanish in a color-free session, and a cursor that paints
 * nothing is a cursor you cannot find, so the projection degrades it to the
 * attribute that means the same thing: `inverse` (SGR 7), which `NO_COLOR`
 * keeps. Taking the whole style from here, rather than the two tokens, is what
 * makes one call site correct in both worlds.
 *
 * A surface whose selection is already carried by a glyph (Home's `▸` prefix,
 * the scanners and chips) needs none of this: it stays readable either way.
 */
export function selectionStyle(
  theme: { bg?: string; accent?: string; dim?: string },
  /** The fill: `accent` for a normal cursor, `dim` for the "free text" row. */
  fill: "accent" | "dim" = "accent",
): {
  color?: string;
  backgroundColor?: string;
  inverse?: boolean;
} {
  const background = theme[fill];
  return theme.bg === undefined || background === undefined
    ? { inverse: true }
    : { color: theme.bg, backgroundColor: background };
}
