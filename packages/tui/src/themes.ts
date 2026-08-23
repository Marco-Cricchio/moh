import React, { createContext, useContext } from "react";

/**
 * Semantic color tokens — components never use raw hex. Theme catalog of 15
 * (see docs/tui-style-guide.md §5). Retro palettes are researched
 * reproductions (research/retro-theme-palettes.md).
 */
export interface Theme {
  label: string;
  fg: string;
  accent: string;
  dim: string;
  ok: string;
  warn: string;
  purple: string;
  border: string;
  bg: string;
}

export const THEMES = {
  "tokyo-night": { label: "Tokyo Night", fg: "#c0caf5", accent: "#7aa2f7", dim: "#565f89", ok: "#9ece6a", warn: "#e0af68", purple: "#bb9af7", border: "#292e42", bg: "#16161e" },
  "catppuccin": { label: "Catppuccin Mocha", fg: "#cdd6f4", accent: "#89b4fa", dim: "#6c7086", ok: "#a6e3a1", warn: "#f9e2af", purple: "#cba6f7", border: "#45475a", bg: "#1e1e2e" },
  "gruvbox": { label: "Gruvbox Dark", fg: "#ebdbb2", accent: "#83a598", dim: "#7c6f64", ok: "#b8bb26", warn: "#fabd2f", purple: "#d3869b", border: "#504945", bg: "#282828" },
  "nord": { label: "Nord", fg: "#d8dee9", accent: "#88c0d0", dim: "#4c566a", ok: "#a3be8c", warn: "#ebcb8b", purple: "#b48ead", border: "#434c5e", bg: "#2e3440" },
  "dracula": { label: "Dracula", fg: "#f8f8f2", accent: "#bd93f9", dim: "#6272a4", ok: "#50fa7b", warn: "#f1fa8c", purple: "#ff79c6", border: "#44475a", bg: "#282a36" },
  "solarized": { label: "Solarized Dark", fg: "#93a1a1", accent: "#268bd2", dim: "#586e75", ok: "#859900", warn: "#b58900", purple: "#6c71c4", border: "#073642", bg: "#002b36" },
  "c64": { label: "Commodore 64", fg: "#b8b0f0", accent: "#7869c4", dim: "#5f5299", ok: "#94e089", warn: "#b8b445", purple: "#6c4fc9", border: "#7869c4", bg: "#40318d" },
  "amiga": { label: "Amiga OS", fg: "#ffffff", accent: "#aaaaaa", dim: "#8a8fa8", ok: "#ffffff", warn: "#ff9900", purple: "#ff9900", border: "#ffffff", bg: "#0055aa" },
  "phosphor": { label: "Green Phosphor", fg: "#00ff00", accent: "#00ff00", dim: "#008800", ok: "#00cc00", warn: "#00ff41", purple: "#00dd00", border: "#00aa00", bg: "#000000" },
  // Retro-OS + vivid set (issue #114, spec tui-dashboard-restyle §D11).
  // win95: teal desktop, silver chrome, navy titles, black text.
  "win95": { label: "Windows 95", fg: "#000000", accent: "#000080", dim: "#808080", ok: "#008000", warn: "#a00000", purple: "#800080", border: "#c0c0c0", bg: "#008080" },
  // dos: MS-DOS blue #0000AA, Norton cyan, CP437 yellow/magenta.
  "dos": { label: "MS-DOS / Norton", fg: "#ffffff", accent: "#55ffff", dim: "#5555ff", ok: "#55ff55", warn: "#ffff55", purple: "#ff55ff", border: "#0000aa", bg: "#0000aa" },
  // mac-platinum: first LIGHT theme — System 7–9 platinum #DDDDDD, black
  // text, amber accent. dim/border audited for contrast on the light bg.
  "mac-platinum": { label: "Mac OS Platinum", fg: "#000000", accent: "#804400", dim: "#595959", ok: "#0a6e0a", warn: "#b33a00", purple: "#5a2d82", border: "#8a8a8a", bg: "#dddddd" },
  "neon-noir": { label: "Neon Noir", fg: "#e8f0ff", accent: "#00e5ff", dim: "#5a7a9a", ok: "#00ff9d", warn: "#ffb300", purple: "#ff2ec4", border: "#2a3f5a", bg: "#0a0e1a" },
  "lava": { label: "Lava", fg: "#ffe8d6", accent: "#ff6a00", dim: "#8a4a2a", ok: "#ffd23f", warn: "#ff2e2e", purple: "#ff4fa3", border: "#5a2c18", bg: "#1c0e08" },
  "candy": { label: "Candy Pop", fg: "#fff0fa", accent: "#ff4fa3", dim: "#9a6a8a", ok: "#3dffb0", warn: "#ffe14d", purple: "#7a5cff", border: "#5a2a48", bg: "#1a0d16" },
} as const satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;

/** Theme keys in catalog order: index i ↔ number key i+1. */
export const THEME_ORDER = Object.keys(THEMES) as ThemeName[];

export const DEFAULT_THEME: ThemeName = "tokyo-night";

/** Theme lives in React state/context, never a mutable global. */
const ThemeCtx = createContext<Theme>(THEMES[DEFAULT_THEME]);

export const ThemeProvider = ThemeCtx.Provider;
export const useTheme = (): Theme => useContext(ThemeCtx);
