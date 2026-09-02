import React, { createContext, useContext } from "react";

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
}

export const THEMES = {
  "tokyo-night": { label: "Tokyo Night", fg: "#c0caf5", accent: "#7aa2f7", dim: "#565f89", muted: "#9aa5ce", ok: "#9ece6a", warn: "#e0af68", err: "#f7768e", purple: "#bb9af7", border: "#292e42", bg: "#16161e" },
  "catppuccin": { label: "Catppuccin Mocha", fg: "#cdd6f4", accent: "#89b4fa", dim: "#6c7086", muted: "#a6b0d8", ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8", purple: "#cba6f7", border: "#45475a", bg: "#1e1e2e" },
  "gruvbox-material": { label: "Gruvbox · Material", fg: "#d4be98", accent: "#89b482", dim: "#7c6f64", muted: "#b0a184", ok: "#a9b665", warn: "#d8a657", err: "#ea6962", purple: "#d3869b", border: "#45403d", bg: "#1d2021" },
  "phosphor": { label: "Green Phosphor", fg: "#00ff00", accent: "#00ff00", dim: "#008800", muted: "#00cc00", ok: "#00cc00", warn: "#00ff41", err: "#ff5555", purple: "#00dd00", border: "#00aa00", bg: "#000000" },
  "phosphor-amber": { label: "Amber Phosphor (P3)", fg: "#ffb000", accent: "#ffb000", dim: "#8a6000", muted: "#cc9000", ok: "#ffd000", warn: "#ff7b00", err: "#ff5555", purple: "#ff9500", border: "#a07000", bg: "#100800" },
  "neon-noir": { label: "Neon Noir", fg: "#e8f0ff", accent: "#00e5ff", dim: "#5a7a9a", muted: "#a3b8d0", ok: "#00ff9d", warn: "#ffb300", err: "#ff2e63", purple: "#ff2ec4", border: "#2a3f5a", bg: "#0a0e1a" },
  "lava": { label: "Lava", fg: "#ffe8d6", accent: "#ff6a00", dim: "#8a4a2a", muted: "#c8a088", ok: "#ffd23f", warn: "#ff2e2e", err: "#ff1a1a", purple: "#ff4fa3", border: "#5a2c18", bg: "#1c0e08" },
  "candy": { label: "Candy Pop", fg: "#fff0fa", accent: "#ff4fa3", dim: "#9a6a8a", muted: "#ccabcd", ok: "#3dffb0", warn: "#ffe14d", err: "#ff5f7a", purple: "#7a5cff", border: "#5a2a48", bg: "#1a0d16" },
} as const satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;

/** Theme keys in catalog order: index i ↔ number key i+1. */
export const THEME_ORDER = Object.keys(THEMES) as ThemeName[];

export const DEFAULT_THEME: ThemeName = "tokyo-night";

/** Theme lives in React state/context, never a mutable global. */
const ThemeCtx = createContext<Theme>(THEMES[DEFAULT_THEME]);

export const ThemeProvider = ThemeCtx.Provider;
export const useTheme = (): Theme => useContext(ThemeCtx);
