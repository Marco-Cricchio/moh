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
 * Colors remain structured until Ink renders them (#1738). Raw RGB escapes
 * bypass terminal capability detection and corrupt older Terminal.app screens.
 * Ink owns color-depth conversion; the component also honours NO_COLOR.
 */

/** The gradient-string palettes worth stealing (bench-verified stop
 * endpoints, #1304), as `[from, to]` hex pairs. */
export const RAMP_PRESETS = {
  atlas: ["#feac5e", "#4bc0c8"],
  fruit: ["#ff4e50", "#f9d423"],
  mind: ["#473b7b", "#30d2be"],
  vice: ["#5ee7df", "#b490ca"],
} as const;

export type RampPresetName = keyof typeof RAMP_PRESETS;

const RAMP_PRESET_NAMES = Object.keys(RAMP_PRESETS) as RampPresetName[];

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

export interface RampSegment {
  text: string;
  color?: string;
}

/** Interpolates colored text runs without emitting terminal escapes.
 * Spaces stay unpainted; Ink chooses the supported color depth at render time. */
export function rampText(text: string, from: string, to: string): RampSegment[] {
  const chars = [...text];
  const segments: RampSegment[] = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    const color = char === " " ? undefined : lerpHex(from, to, chars.length === 1 ? 1 : i / (chars.length - 1));
    const previous = segments.at(-1);
    if (previous && previous.color === color) previous.text += char;
    else segments.push({ text: char, ...(color ? { color } : {}) });
  }
  return segments;
}

/** The settled logo's two ramp rows from one preset: the tagline spans the
 * first half of the stops, the version line continues from the tagline's
 * final color — the two share the midpoint color exactly (continuity). */
export function rampLogoRows(
  tagline: string,
  version: string | null,
  preset: RampPresetName,
): { tagline: RampSegment[]; version: RampSegment[] | null } {
  const [from, to] = RAMP_PRESETS[preset];
  const mid = lerpHex(from, to, 0.5);
  return {
    tagline: rampText(tagline, from, mid),
    version: version === null ? null : rampText(version, mid, to),
  };
}
