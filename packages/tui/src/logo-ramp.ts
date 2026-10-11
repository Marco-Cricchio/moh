/**
 * The logo gradient ramp (#1304): tagline and version painted per character
 * from one gradient-string-tuned preset as ONE continuous ramp — the version
 * line picks up exactly where the tagline ends (the tagline spans the first
 * half of the stops, the version continues from its final color to the last
 * stop). Painted by hand over the preset's stop colors: gradient-string's
 * `multiline()` joins its argument with commas and cannot carry two rows,
 * and a runtime gradient library for two lines of chrome is a dep moh does
 * not need.
 *
 * #880: every color-opening escape comes from `fgTruecolor`, so a `NO_COLOR`
 * run emits bare text — the component layer renders the `Dim` treatment in
 * that case, never escapes.
 */

import { fgTruecolor } from "./color";

/** The gradient-string palettes worth stealing (bench-verified stop
 * endpoints, #1304), as `[from, to]` hex pairs. */
export const RAMP_PRESETS = {
  atlas: ["#feac5e", "#4bc0c8"],
  fruit: ["#ff4e50", "#f9d423"],
  mind: ["#473b7b", "#30d2be"],
  vice: ["#5ee7df", "#b490ca"],
} as const;

export type RampPresetName = keyof typeof RAMP_PRESETS;

export const RAMP_PRESET_NAMES = Object.keys(RAMP_PRESETS) as RampPresetName[];

/** One preset per mount, uniformly. Injectable via props for tests. */
export function pickRampPreset(): RampPresetName {
  return RAMP_PRESET_NAMES[Math.floor(Math.random() * RAMP_PRESET_NAMES.length)]!;
}

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Linear interpolation between two hex colors; `t` clamps to 0…1. */
export function lerpHex(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const pa = hexRgb(a);
  const pb = hexRgb(b);
  return (
    "#" +
    pa
      .map((v, i) => Math.round(v + (pb[i]! - v) * k).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Paints `text` from `from` to `to`, one truecolor escape per character
 * (spaces stay unpainted, resets close each painted run). With no color
 * capability the escapes vanish and the text comes back bare (#880). */
export function rampText(text: string, from: string, to: string): string {
  const chars = [...text];
  if (chars.length === 0) return "";
  let out = "";
  let open: string | null = null;
  const colorAt = (i: number) =>
    lerpHex(from, to, chars.length === 1 ? 1 : i / (chars.length - 1));
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === " ") {
      if (open !== null) {
        out += "\x1b[39m";
        open = null;
      }
      out += c;
      continue;
    }
    const esc = fgTruecolor(colorAt(i));
    if (esc === "") {
      out += c;
      continue;
    }
    if (esc !== open) {
      if (open !== null) out += "\x1b[39m";
      out += esc;
      open = esc;
    }
    out += c;
  }
  if (open !== null) out += "\x1b[39m";
  return out;
}

/** The settled logo's two ramp rows from one preset: the tagline spans the
 * first half of the stops, the version line continues from the tagline's
 * final color — the two share the midpoint color exactly (continuity). */
export function rampLogoRows(
  tagline: string,
  version: string | null,
  preset: RampPresetName,
): { tagline: string; version: string | null } {
  const [from, to] = RAMP_PRESETS[preset];
  const mid = lerpHex(from, to, 0.5);
  return {
    tagline: rampText(tagline, from, mid),
    version: version === null ? null : rampText(version, mid, to),
  };
}
