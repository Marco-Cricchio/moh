import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./themes";

import { dialogWidth, useViewport } from "./viewport";

/** pi-style labelled message box: single round border, label row inside. */
export function MsgBox({ label, color, children }: { label: string; color: string; children: React.ReactNode }) {
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
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/\t/g, "  ");
}

/** moh logo, bold+underline accent */
export function Logo() {
  const theme = useTheme();
  return (
    <Text bold underline color={theme.accent}>
      moh &gt;
    </Text>
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
  color: string;
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
        backgroundColor={theme.bg}
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
