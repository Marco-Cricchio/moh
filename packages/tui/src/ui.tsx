import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";
import { colorEnabled } from "./color";
import { pickRampPreset, rampLogoRows, type RampPresetName } from "./logo-ramp";

import { dialogWidth, useViewport } from "./viewport";
import { sanitizeForDisplay } from "./render-sanitize";

/** pi-style labelled message box: single round border, label row inside. */
export function MsgBox({ label, color, children }: { label: string; /** #880: absent when the terminal takes no color. */ color?: string; children: React.ReactNode }) {
  return (
    <Box borderStyle="round" borderColor={color} flexDirection="column" width="100%" paddingX={1}>
      <Text color={color}>{label}</Text>
      {children}
    </Box>
  );
}

/** dim text in the theme's dim token */
export function Dim({ children }: { children: React.ReactNode }) {
  return <Text color={useTheme().dim}>{children}</Text>;
}

/** accent text */
export function Accent({ children }: { children: React.ReactNode }) {
  return <Text color={useTheme().accent}>{children}</Text>;
}

/** context-sensitive footer: one dim line of keys valid right now */
export function Footer({ keys }: { keys: string }) {
  const theme = useTheme();
  return (
    <Box justifyContent="center">
      <Text color={theme.dim} wrap="truncate-end">{` ${keys} `}</Text>
    </Box>
  );
}

/** Elide a string to `n` visible chars with an ellipsis. */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

/**
 * Strips terminal control characters and ANSI escape sequences from a
 * single-line string before it enters the frame. Tool output can carry
 * raw control bytes (vite's `\x1b[2K\r`, progress `\r`, stray ESC) that
 * would move the *terminal* cursor while Ink's model disagrees — every
 * later frame then renders diagonally out of place. Callers split on
 * `\n` first; this removes everything else that moves a cursor.
 */
export function sanitizeLine(s: string): string {
  // Lines are a layout concern: tabs expand to spaces after the common
  // display boundary retained them for multi-line/modal rendering.
  return sanitizeForDisplay(s).replace(/\t/g, "  ");
}

/** figlet-Slant banner for the home screen (#292). */
export const LOGO_BANNER = [
  "    ____ ___  ____  / /_ ",
  "   / __ `__ \\/ __ \\/ __ \\",
  "  / / / / / / /_/ / / / /",
  " /_/ /_/ /_/\\____/_/ /_/ ",
];

/** The splash fonts (#1304), pre-rendered with figlet 1.12 `textSync("MoH")`
 * and committed as literals — figlet is not a TUI dependency, and literals
 * are greppable and dependency-free. The splash varies by font; the settled
 * home logo stays the canonical Slant `LOGO_BANNER`. */
export const SPLASH_BANNERS = {
  Ghost: [
    " _   .-')                 ('-. .-. ",
    "( '.( OO )_              ( OO )  / ",
    " ,--.   ,--.).-'),-----. ,--. ,--. ",
    " |   `.'   |( OO'  .-.  '|  | |  | ",
    " |         |/   |  | |  ||   .|  | ",
    " |  |'.'|  |\\_) |  |\\|  ||       | ",
    " |  |   |  |  \\ |  | |  ||  .-.  | ",
    " |  |   |  |   `'  '-'  '|  | |  | ",
    " `--'   `--'     `-----' `--' `--' ",
  ],
  Slant: LOGO_BANNER,
  Block: [
    "                                 ",
    " _|      _|            _|    _|  ",
    " _|_|  _|_|    _|_|    _|    _|  ",
    " _|  _|  _|  _|    _|  _|_|_|_|  ",
    " _|      _|  _|    _|  _|    _|  ",
    " _|      _|    _|_|    _|    _|  ",
    "                                 ",
    "                                 ",
  ],
  Standard: [
    "  __  __       _   _ ",
    " |  \\/  | ___ | | | |",
    " | |\\/| |/ _ \\| |_| |",
    " | |  | | (_) |  _  |",
    " |_|  |_|\\___/|_| |_|",
    "                     ",
  ],
  Big: [
    "  __  __       _    _ ",
    " |  \\/  |     | |  | |",
    " | \\  / | ___ | |__| |",
    " | |\\/| |/ _ \\|  __  |",
    " | |  | | (_) | |  | |",
    " |_|  |_|\\___/|_|  |_|",
    "                      ",
    "                      ",
  ],
  Small: [
    "  __  __     _  _ ",
    " |  \\/  |___| || |",
    " | |\\/| / _ \\ __ |",
    " |_|  |_\\___/_||_|",
    "                  ",
  ],
};

export type SplashFontName = keyof typeof SPLASH_BANNERS;

/** One splash font per mount, uniformly. Injectable for tests. */
export function pickSplashFont(): SplashFontName {
  const names = Object.keys(SPLASH_BANNERS) as SplashFontName[];
  return names[Math.floor(Math.random() * names.length)]!;
}

/** moh logo (#292): the figlet-Slant banner with the "My Own Harness"
 * acronym and the version number on tall non-compact terminals; a one-liner
 * everywhere else. Acronym and version share the banner's centered column
 * so they stay aligned to each other.
 *
 * #1304: tagline and version are painted from ONE continuous gradient ramp
 * (one preset per mount; injectable for tests). With no color capability the
 * rows degrade to the plain dim treatment (#880). */
export function Logo({
  banner = true,
  version,
  rampPreset,
}: { banner?: boolean; version?: string; rampPreset?: RampPresetName }) {
  const theme = useTheme();
  if (!banner) {
    return (
      <Text bold color={theme.accent}>
        moh &gt; <Dim>— My Own Harness</Dim>
      </Text>
    );
  }
  const preset = rampPreset ?? pickRampPreset();
  const rows = rampLogoRows("My Own Harness", version ? `v${version}` : null, preset);
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color={theme.accent}>{LOGO_BANNER.join("\n")}</Text>
      {colorEnabled() ? (
        <Text>{rows.tagline}</Text>
      ) : (
        <Dim>My Own Harness</Dim>
      )}
      {rows.version !== null ? (colorEnabled() ? <Text>{rows.version}</Text> : <Dim>{rows.version}</Dim>) : null}
    </Box>
  );
}

/**
 * Shared modal overlay shape (style guide §8): centered against the full
 * viewport on both axes, round border in the overlay's semantic color,
 * solid background for contrast over the transcript, and a
 * viewport-derived width (`dialogWidth`: ~62% clamped to the readable
 * measure; full terminal width in compact mode).
 */
export function Dialog({
  title,
  color,
  width,
  center = true,
  children,
}: {
  title: string;
  /** #880: absent when the terminal takes no color. */
  color?: string;
  width?: number | string;
  center?: boolean;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const viewport = useViewport();
  return (
    <Box width="100%" height={center ? "100%" : undefined} alignItems="center" justifyContent={center ? "center" : "flex-start"} flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={color}
        backgroundColor={theme.surface}
        width={width ?? dialogWidth(viewport)}
        paddingX={2}
        flexDirection="column"
        flexShrink={0}
      >
        <Text color={color} bold>
          {title}
        </Text>
        <Text> </Text>
        {children}
      </Box>
    </Box>
  );
}

/**
 * One row of a ScrollDialog body: the node plus how many visual lines it
 * occupies (a wrapped description counts its wrapped rows — computed by the
 * caller with `wrapLines`, since only it knows the width).
 */
export interface ScrollRow {
  node: React.ReactNode;
  weight: number;
}

/**
 * A read-only dialog whose body scrolls when it does not fit the viewport
 * (the vertical-overflow guarantee): rows window inside the remaining
 * height, `↑`/`↓`/`j`/`k` scroll one row at a time, and `↑ N more` /
 * `↓ N more` indicators report what is hidden — the same vocabulary the
 * height-aware menus already use (#64). Fixed header/footer nodes stay on
 * screen; only the rows scroll.
 */
export function ScrollDialog({
  title,
  color,
  width,
  rows,
  header,
  footer,
  scrollHint = true,
}: {
  title: string;
  color?: string;
  width?: number | string;
  rows: ScrollRow[];
  header?: React.ReactNode;
  /** Fixed trailing node (hints, status): always visible, outside the window. */
  footer?: React.ReactNode;
  scrollHint?: boolean;
}) {
  const theme = useTheme();
  const viewport = useViewport();
  const [offset, setOffset] = useState(0);
  // Dialog chrome: border (2) + title + spacer + the window's own more-
  // indicator row + the fixed footer. Never less than one row of body.
  const budget = Math.max(1, viewport.rows - 7);
  const weights = rows.map((r) => r.weight);
  const totalWeight = weights.reduce((a, w) => a + w, 0);
  const clampedOffset = Math.min(offset, Math.max(0, rows.length - 1));
  // Grow the window downward from the offset, then upward, until the budget
  // is spent — the weight-aware mirror of LanesModal's windowFor.
  let start = clampedOffset;
  let end = start + 1;
  let used = weights[start] ?? 0;
  if (used > budget) used = budget;
  for (;;) {
    let grew = false;
    if (end < rows.length && used + weights[end]! <= budget) {
      used += weights[end]!;
      end++;
      grew = true;
    }
    if (start > 0 && used + weights[start - 1]! <= budget) {
      start--;
      used += weights[start]!;
      grew = true;
    }
    if (!grew) break;
  }
  const aboveWeight = weights.slice(0, start).reduce((a, w) => a + w, 0);
  const belowWeight = weights.slice(end).reduce((a, w) => a + w, 0);
  const scrollable = totalWeight > budget;
  React.useEffect(() => {
    setOffset((o) => Math.min(o, Math.max(0, rows.length - 1)));
    // Re-clamp when the row list shrinks (e.g. after a filter or refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);
  useInput((input, key) => {
    if (!scrollable) return;
    if (key.upArrow || input === "k") setOffset((o) => Math.max(0, o - 1));
    if (key.downArrow || input === "j") setOffset((o) => Math.min(Math.max(0, rows.length - 1), o + 1));
  });
  return (
    <Dialog title={title} color={color} width={width}>
      {header}
      {aboveWeight > 0 && <Dim>{` ↑ ${aboveWeight} more`}</Dim>}
      {rows.slice(start, end).map((row, i) => (
        <React.Fragment key={start + i}>{row.node}</React.Fragment>
      ))}
      {belowWeight > 0 && (
        <Dim>{` ↓ ${belowWeight} more${scrollHint && scrollable ? " (↑↓ scroll)" : ""}`}</Dim>
      )}
      <Text> </Text>
      {footer}
    </Dialog>
  );
}

/** Compact token/counter form: `1.5k`, `20.0M`, plain below 1000 (#718).
 * Shared by the quota modal's local rows and Home's usage line. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
