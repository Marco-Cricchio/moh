import React from "react";
import { Box, Text } from "ink";
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

/** moh logo, bold+underline accent */
export function Logo() {
  const theme = useTheme();
  return (
    <Text bold underline color={theme.accent}>
      moh &gt;
    </Text>
  );
}
