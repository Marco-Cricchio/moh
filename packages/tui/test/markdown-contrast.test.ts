import { describe, expect, test } from "bun:test";
import { createMarkdownRenderer, parseAnsiSegments } from "../src/markdown";
import { THEMES, type Theme, type ThemeName } from "../src/themes";
import { stripAnsi } from "./helpers";

/**
 * Markdown palette contrast audit (owner report, session 2026-09-05): the
 * chat's markdown palette has unclear contrast for secondary text, quotes,
 * links and code accents on the reply block's tinted background. The audit
 * renders one full fixture through the real renderer in every theme,
 * extracts the emitted fg colors and asserts WCAG contrast ratios against
 * the effective block background (semantic tint mixed over theme.bg — the
 * same math as TranscriptBlockView's Row backgrounds).
 */

const FIXTURE = [
  "# Heading one",
  "",
  "Body prose paragraph with **bold**, *italic* and an inline `codespan` plus a [link](https://example.com).",
  "",
  "> A blockquote line",
  "",
  "- bullet item",
  "- second item",
  "",
  "1. ordered one",
  "",
  "| col a | col b |",
  "| --- | --- |",
  "| one | two |",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const mix = (a: string, b: string, t: number): string => {
  // Matches transcript.tsx's mix: result = a*amount + b*(1-amount).
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return `#${ca.map((v, i) => Math.round(v * t + cb[i]! * (1 - t)).toString(16).padStart(2, "0")).join("")}`;
};

const luminance = (hex: string): number => {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

export const contrast = (fgHex: string, bgHex: string): number => {
  const l1 = luminance(fgHex);
  const l2 = luminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/** Reply blocks tint fg toward the accent at 0.14 over bg (blockTint). */
const replyBackground = (theme: Theme): string => mix(theme.accent, theme.bg, 0.14);

const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

describe("markdown palette contrast audit", () => {
  for (const name of THEME_ORDER_SAFE()) {
    test(`all styled runs meet 3:1 on the reply tint — ${name}`, () => {
      const theme = THEMES[name];
      const md = createMarkdownRenderer(theme, 80);
      // marked's sync renderer is typed as string | Promise<string>.
      const rendered = String(md.parse(FIXTURE));
      const bg = replyBackground(theme);
      const failures: string[] = [];
      for (const line of rendered.split("\n")) {
        if (stripAnsi(line).trim() === "") continue;
        for (const segment of parseAnsiSegments(line)) {
          if (!segment.color) continue;
          const ratio = contrast(segment.color, bg);
          if (ratio < 3) failures.push(`${segment.color} on ${bg} = ${ratio.toFixed(2)} — "${segment.text.slice(0, 24)}"`);
        }
      }
      expect(failures.join("\n")).toBe("");
    });
  }
});

function THEME_ORDER_SAFE(): ThemeName[] {
  return Object.keys(THEMES) as ThemeName[];
}
