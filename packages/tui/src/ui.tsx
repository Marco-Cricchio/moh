import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, measureElement, type DOMElement } from "ink";
import { useTheme } from "./themes";
import { colorEnabled } from "./color";
import { pickRampPreset, rampLogoRows, type RampPresetName } from "./logo-ramp";

import { dialogWidth, useViewport } from "./viewport";
import { sanitizeForDisplay } from "@moh/core";

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

/** One body item. Legacy callers may still supply a weight; layout is measured by Ink. */
export interface ScrollRow {
  node: React.ReactNode;
  weight?: number;
}

/**
 * A read-only dialog whose body scrolls when it does not fit the viewport
 * (the vertical-overflow guarantee): rows window inside the remaining
 * height, `↑`/`↓`/`j`/`k` scroll one rendered line at a time, and `↑ N more` /
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
  // Measure the unconstrained content inside its Yoga-sized clipping window.
  // Text flattening cannot account for separate blocks or actual terminal wrapping.
  const windowRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const [geometry, setGeometry] = useState({ visible: 0, total: 0 });
  useEffect(() => {
    if (!windowRef.current || !contentRef.current) return;
    const visible = measureElement(windowRef.current).height;
    const total = measureElement(contentRef.current).height;
    setGeometry((previous) => previous.visible === visible && previous.total === total ? previous : { visible, total });
  });
  const maximum = Math.max(0, geometry.total - geometry.visible);
  const scrollable = maximum > 0;
  const top = Math.min(offset, maximum);
  useEffect(() => { setOffset((previous) => Math.min(previous, maximum)); }, [maximum]);
  useInput((input, key) => {
    if (key.upArrow || input === "k") setOffset((previous) => Math.max(0, previous - 1));
    if (key.downArrow || input === "j") setOffset((previous) => Math.min(maximum, previous + 1));
  });
  return (
    <Box width="100%" height="100%" alignItems="center" justifyContent="center" flexDirection="column">
      <Box
        borderStyle="round" borderColor={color} backgroundColor={theme.surface}
        width={width ?? Math.min(dialogWidth(viewport), Math.max(1, viewport.columns - 1))}
        height={Math.max(1, viewport.rows - 1)}
        paddingX={2} flexDirection="column" flexShrink={0} overflow="hidden"
      >
        <Box flexDirection="column" flexShrink={0}>
          <Text color={color} bold>{title}</Text>
          <Text> </Text>
          {header}
        </Box>
        {scrollable && <Box flexShrink={0}><Text color={theme.dim} wrap="truncate-end">{top > 0 ? ` ↑ ${top} more` : " "}</Text></Box>}
        <Box ref={windowRef} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
          <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-top}>
            {rows.map((row, i) => <React.Fragment key={i}>{row.node}</React.Fragment>)}
          </Box>
        </Box>
        {scrollable && <Box flexShrink={0}><Text color={theme.dim} wrap="truncate-end">{maximum > top ? ` ↓ ${maximum - top} more${scrollHint ? " (↑↓ scroll)" : ""}` : " "}</Text></Box>}
        <Box flexDirection="column" flexShrink={0}>
          <Text> </Text>
          {footer}
        </Box>
      </Box>
    </Box>
  );
}

/** Compact token/counter form: `1.5k`, `20.0M`, plain below 1000 (#718).
 * Shared by the quota modal's local rows and Home's usage line. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
