import React, { createContext, useContext } from "react";
import { colorEnabled } from "./color";

/**
 * Semantic color tokens — components never use raw hex. Theme catalog of 8
 * (see docs/tui-style-guide.md §5). Retro palettes are researched
 * reproductions (research/retro-theme-palettes.md).
 */
export interface Theme {
  label: string;
  fg: string;
  accent: string;
  dim: string;
  /** Mid-tone between fg and dim: secondary text that must stay readable
   * under focus (e.g. the focused option's description) — #426. */
  muted: string;
  ok: string;
  warn: string;
  purple: string;
  border: string;
  /** True error red, distinct from the amber warning token. */
  err: string;
  bg: string;
  /** Base surface (#749): panels and mixed tints sit on this, not raw bg. */
  surface: string;
  /** Raised surface: nested boxes on top of a surface. */
  surfaceRaised: string;
  /** Highlighted/focused surface. */
  selection: string;
}

/** Editable color roles for user themes (#749): every token except label. */
export const COLOR_ROLES = [
  "fg", "accent", "dim", "muted", "ok", "warn", "err", "purple",
  "border", "bg", "surface", "surfaceRaised", "selection",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

/** Roles the ≥3:1 contrast check covers (#749): text and accent roles.
 * Surface tokens (bg, surface, surfaceRaised) and border are exempt. */
export const TEXT_ACCENT_ROLES = ["fg", "accent", "dim", "muted", "ok", "warn", "err", "purple"] as const;

export const THEMES = {
  "tokyo-night": { label: "Tokyo Night", fg: "#c0caf5", accent: "#7aa2f7", dim: "#5b678f", muted: "#9aa5ce", ok: "#9ece6a", warn: "#e0af68", err: "#f7768e", purple: "#bb9af7", border: "#292e42", bg: "#16161e", surface: "#1a1c27", surfaceRaised: "#20232f", selection: "#2a3352" },
  "catppuccin": { label: "Catppuccin Mocha", fg: "#cdd6f4", accent: "#89b4fa", dim: "#6c7086", muted: "#a6b0d8", ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8", purple: "#cba6f7", border: "#45475a", bg: "#1e1e2e", surface: "#24243a", surfaceRaised: "#2b2b45", selection: "#3f445f" },
  "gruvbox-material": { label: "Gruvbox · Material", fg: "#d4be98", accent: "#89b482", dim: "#7c6f64", muted: "#b0a184", ok: "#a9b665", warn: "#d8a657", err: "#ea6962", purple: "#d3869b", border: "#45403d", bg: "#1d2021", surface: "#232627", surfaceRaised: "#2a2d2e", selection: "#3a4448" },
  "phosphor": { label: "Green Phosphor", fg: "#00ff00", accent: "#00ff00", dim: "#008800", muted: "#00cc00", ok: "#00cc00", warn: "#00ff41", err: "#ff5555", purple: "#00dd00", border: "#00aa00", bg: "#000000", surface: "#001100", surfaceRaised: "#002200", selection: "#004400" },
  "phosphor-amber": { label: "Amber Phosphor (P3)", fg: "#ffb000", accent: "#ffb000", dim: "#8a6000", muted: "#cc9000", ok: "#ffd000", warn: "#ff7b00", err: "#ff5555", purple: "#ff9500", border: "#a07000", bg: "#100800", surface: "#181000", surfaceRaised: "#201800", selection: "#3a2c00" },
  "neon-noir": { label: "Neon Noir", fg: "#e8f0ff", accent: "#00e5ff", dim: "#5a7a9a", muted: "#a3b8d0", ok: "#00ff9d", warn: "#ffb300", err: "#ff2e63", purple: "#ff2ec4", border: "#2a3f5a", bg: "#0a0e1a", surface: "#101626", surfaceRaised: "#161e33", selection: "#223554" },
  "lava": { label: "Lava", fg: "#ffe8d6", accent: "#ff6a00", dim: "#a05a34", muted: "#c8a088", ok: "#ffd23f", warn: "#ff2e2e", err: "#ff1a1a", purple: "#ff4fa3", border: "#5a2c18", bg: "#1c0e08", surface: "#25130b", surfaceRaised: "#2e1810", selection: "#472318" },
  "candy": { label: "Candy Pop", fg: "#fff0fa", accent: "#ff4fa3", dim: "#9a6a8a", muted: "#ccabcd", ok: "#3dffb0", warn: "#ffe14d", err: "#ff5f7a", purple: "#7a5cff", border: "#5a2a48", bg: "#1a0d16", surface: "#23111d", surfaceRaised: "#2c1625", selection: "#45203a" },
  // Validated on prototype/theme-viewport.tsx (gitignored prototype; owner
  // reviewed 2026-09): faithful palettes, brightened in-family where the raw
  // color falls under the 3:1 text floor — tuned on bg AND surface.
  "commodore64": { label: "Commodore 64", fg: "#a6a0ef", accent: "#9f94e0", dim: "#a29af0", muted: "#ababd8", ok: "#9ad284", warn: "#b8c76f", err: "#de9271", purple: "#c095ea", border: "#6c5eb5", bg: "#40318d", surface: "#483995", surfaceRaised: "#4e409b", selection: "#5445a0" },
  "amiga-workbench13": { label: "Amiga Workbench 1.3", fg: "#ffffff", accent: "#ffa93c", dim: "#8ecbff", muted: "#a6c0e2", ok: "#23d968", warn: "#ffcc00", err: "#ff9499", purple: "#f19bf1", border: "#004488", bg: "#0055aa", surface: "#1a548e", surfaceRaised: "#1f5e9c", selection: "#2b6ba8" },
  "iron-man": { label: "Iron Man", fg: "#e8e6e3", accent: "#ff6b00", dim: "#8a9199", muted: "#b5bcc4", ok: "#ffd23f", warn: "#ff9500", err: "#ff3344", purple: "#00c2ff", border: "#4a1518", bg: "#1a0f10", surface: "#372d2e", surfaceRaised: "#4e4545", selection: "#5f2b0b" },
  "star-wars": { label: "Star Wars", fg: "#e5e7eb", accent: "#ffe81f", dim: "#697590", muted: "#8b95a5", ok: "#4ade80", warn: "#ffb84d", err: "#ff4d4d", purple: "#54d8ff", border: "#1c2028", bg: "#0b0c10", surface: "#2a2b2f", surfaceRaised: "#424347", selection: "#413c13" },
  "daylight": { label: "Daylight", fg: "#1f2937", accent: "#b45309", dim: "#64748b", muted: "#475569", ok: "#15803d", warn: "#92400e", err: "#b91c1c", purple: "#6d28d9", border: "#d1d0cc", bg: "#f5f2ea", surface: "#e0ded8", surfaceRaised: "#d1d0cc", selection: "#e5cab2" },
  "daylight-frost": { label: "Daylight Frost", fg: "#0f172a", accent: "#0369a1", dim: "#64748b", muted: "#475569", ok: "#166534", warn: "#9a3412", err: "#991b1b", purple: "#5b21b6", border: "#cdd0d5", bg: "#f4f6f8", surface: "#dde0e3", surfaceRaised: "#cdd0d5", selection: "#bfd7e5" },
  "tron": { label: "TRON", fg: "#eaf6ff", accent: "#7df9ff", dim: "#6a7880", muted: "#8fa3b0", ok: "#00d9ff", warn: "#ffb000", err: "#ff3355", purple: "#00b8e6", border: "#16303f", bg: "#050a0f", surface: "#252b31", surfaceRaised: "#3e454b", selection: "#23464b" },
  "blade-runner": { label: "Blade Runner", fg: "#e8e2d6", accent: "#ffa94d", dim: "#6d7b73", muted: "#a8b0a8", ok: "#34d399", warn: "#ffce54", err: "#fb7185", purple: "#67e8f9", border: "#2a333c", bg: "#0d1216", surface: "#2c2f31", surfaceRaised: "#444646", selection: "#4a3824" },
  "vaporwave": { label: "Vaporwave '89", fg: "#e2d9ff", accent: "#ff71ce", dim: "#9b8fd4", muted: "#cfcfff", ok: "#05ffa1", warn: "#fffb96", err: "#ff4c68", purple: "#c979ff", border: "#4a3a8c", bg: "#2d1b69", surface: "#48397c", surfaceRaised: "#5e508b", selection: "#623182" },
  "pop-art": { label: "Pop Art", fg: "#111111", accent: "#b3001b", dim: "#333333", muted: "#333333", ok: "#0a5c2e", warn: "#7a5c00", err: "#d62828", purple: "#5e1f73", border: "#ded4c0", bg: "#fff4dd", surface: "#ece2cd", surfaceRaised: "#ded4c0", selection: "#f7cbb9" },
} as const satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;

/** Theme keys in catalog order: index i ↔ number key i+1. */
export const THEME_ORDER = Object.keys(THEMES) as ThemeName[];

export const DEFAULT_THEME: ThemeName = "tokyo-night";

/** Theme lives in React state/context, never a mutable global. */
const ThemeCtx = createContext<Theme>(THEMES[DEFAULT_THEME]);

export const ThemeProvider = ThemeCtx.Provider;

/**
 * A palette as a **component** receives it (#880): the same token names, but
 * every color is `undefined` when the terminal must not receive color codes
 * (`NO_COLOR`, see color.ts). `label` is a name rather than a color, so it
 * always stays.
 *
 * This is the whole color switch for everything painted through Ink: a
 * `<Text color={undefined}>` emits no color (`colorize` returns early on a
 * falsy color) while `bold` and `dimColor` — separate props — survive, which
 * is exactly the line `NO_COLOR` draws. The cost of a color-free terminal is
 * the palette's hierarchy: a `color={theme.dim}` site paints at normal
 * intensity, and what is left to read by is structure, glyphs and the
 * attributes the component asks for explicitly.
 *
 * `Theme` stays the honest palette (always a color per role) so the math —
 * contrast, hex parsing, the theme studio — keeps working on real values.
 */
export type PaintableTheme = { [K in keyof Theme]: K extends "label" ? string : string | undefined };

/** Projections are cached per palette object: a fresh object on every render
 * would invalidate every memo keyed on the theme (the markdown renderer, the
 * block tints). */
const colorFree = new WeakMap<Theme, PaintableTheme>();

function withoutColor(theme: Theme): PaintableTheme {
  const cached = colorFree.get(theme);
  if (cached !== undefined) return cached;
  const projection = Object.fromEntries(
    Object.entries(theme).map(([role, value]) => [role, role === "label" ? value : undefined]),
  ) as PaintableTheme;
  colorFree.set(theme, projection);
  return projection;
}

/** The palette a painter should use. Returns the palette itself when color is
 * allowed, so identity-keyed memos keep working in the common case. */
export function paintable(theme: Theme): PaintableTheme {
  return colorEnabled() ? theme : withoutColor(theme);
}

export const useTheme = (): PaintableTheme => paintable(useContext(ThemeCtx));

/* ---- WCAG relative luminance + contrast (#749) -------------------------- */

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colors. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}

/** A hex color: #rgb or #rrggbb, case-insensitive. */
export function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/** Non-blocking contrast findings (<3:1) for text/accent roles against bg. */
export function contrastWarnings(colors: Record<ColorRole, string>): string[] {
  const warnings: string[] = [];
  for (const role of TEXT_ACCENT_ROLES) {
    const ratio = contrastRatio(colors[role], colors.bg);
    if (ratio < 3) warnings.push(`${role}: contrast ${ratio.toFixed(2)}:1 against bg (below 3:1)`);
  }
  return warnings;
}
