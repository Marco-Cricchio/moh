import React, { createContext, useContext } from "react";

/**
 * Semantic color tokens — components never use raw hex. Theme catalog of 9
 * (keys 1–9, see docs/tui-style-guide.md §5). Retro palettes are researched
 * reproductions (research/retro-theme-palettes.md).
 */
export interface Theme {
  label: string;
  accent: string;
  dim: string;
  ok: string;
  warn: string;
  purple: string;
  border: string;
  bg: string;
}

export const THEMES = {
  "tokyo-night": { label: "Tokyo Night", accent: "#7aa2f7", dim: "#565f89", ok: "#9ece6a", warn: "#e0af68", purple: "#bb9af7", border: "#292e42", bg: "#16161e" },
  "catppuccin": { label: "Catppuccin Mocha", accent: "#89b4fa", dim: "#6c7086", ok: "#a6e3a1", warn: "#f9e2af", purple: "#cba6f7", border: "#45475a", bg: "#1e1e2e" },
  "gruvbox": { label: "Gruvbox Dark", accent: "#83a598", dim: "#7c6f64", ok: "#b8bb26", warn: "#fabd2f", purple: "#d3869b", border: "#504945", bg: "#282828" },
  "nord": { label: "Nord", accent: "#88c0d0", dim: "#4c566a", ok: "#a3be8c", warn: "#ebcb8b", purple: "#b48ead", border: "#434c5e", bg: "#2e3440" },
  "dracula": { label: "Dracula", accent: "#bd93f9", dim: "#6272a4", ok: "#50fa7b", warn: "#f1fa8c", purple: "#ff79c6", border: "#44475a", bg: "#282a36" },
  "solarized": { label: "Solarized Dark", accent: "#268bd2", dim: "#586e75", ok: "#859900", warn: "#b58900", purple: "#6c71c4", border: "#073642", bg: "#002b36" },
  "c64": { label: "Commodore 64", accent: "#7869c4", dim: "#5f5299", ok: "#94e089", warn: "#b8b445", purple: "#6c4fc9", border: "#7869c4", bg: "#40318d" },
  "amiga": { label: "Amiga OS", accent: "#aaaaaa", dim: "#8a8fa8", ok: "#ffffff", warn: "#ff9900", purple: "#ff9900", border: "#ffffff", bg: "#0055aa" },
  "phosphor": { label: "Green Phosphor", accent: "#00ff00", dim: "#008800", ok: "#00cc00", warn: "#00ff41", purple: "#00dd00", border: "#00aa00", bg: "#000000" },
} as const satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;

/** Theme keys in catalog order: index i ↔ number key i+1. */
export const THEME_ORDER = Object.keys(THEMES) as ThemeName[];

export const DEFAULT_THEME: ThemeName = "tokyo-night";

/** Theme lives in React state/context, never a mutable global. */
const ThemeCtx = createContext<Theme>(THEMES[DEFAULT_THEME]);

export const ThemeProvider = ThemeCtx.Provider;
export const useTheme = (): Theme => useContext(ThemeCtx);
