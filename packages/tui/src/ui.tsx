import React from "react";
import { Box, Text, useStdout } from "ink";
import { useTheme } from "./themes";

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
  return (
    <Box justifyContent="center">
      <Dim>{` ${keys} `}</Dim>
    </Box>
  );
}

/** Compact-mode threshold (style guide §1 Q12): below ~60 cols. */
export function useCompact(): boolean {
  const { stdout } = useStdout();
  return (stdout.columns ?? 80) < 60;
}

/** Elide a string to `n` visible chars with an ellipsis. */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
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
 * Shared modal overlay shape (style guide §8): centered, round border in
 * the overlay's semantic color, solid background for contrast over the
 * transcript, ~62% width (full width in compact mode).
 */
export function Dialog({
  title,
  color,
  width,
  children,
}: {
  title: string;
  color: string;
  width?: number | string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Box width="100%" height="100%" alignItems="center" justifyContent="center" flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={color}
        backgroundColor={theme.bg}
        width={width ?? "62%"}
        paddingX={2}
        flexDirection="column"
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
