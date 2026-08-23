import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./themes";
import { Dim, Logo } from "./ui";
import { bodyRows, centerWidth, sidebarWidths, useViewport } from "./viewport";
import type { Mode } from "./Chat";

/** Left menu entries (T4 wires focus + activation; T3 renders them inert). */
export const MENU_ENTRIES = ["Dashboard", "Sessions", "Wayfinder", "Settings", "Help"] as const;

/** Footer keybind chips: icon + name, only keys that are live today. */
const CHIPS: ReadonlyArray<readonly [string, string]> = [
  ["⏎", "send"],
  ["esc", "steer"],
  ["^s", "settings"],
  ["^k", "commands"],
  ["^m", "mode"],
  ["^t", "theme"],
];

/** Prefix of chips that fits one row ("( ⏎ send )" = icon + name + 5, gap 1). */
export function fitChips(chips: ReadonlyArray<readonly [string, string]>, width: number): ReadonlyArray<readonly [string, string]> {
  const budget = width - 2; // paddingX 1 on each side
  let used = -1; // no gap before the first chip
  const out: [string, string][] = [];
  for (const [icon, name] of chips) {
    const w = 5 + icon.length + name.length;
    if (used + 1 + w > budget) break;
    used += 1 + w;
    out.push([icon, name]);
  }
  return out;
}

export interface DashboardProps {
  mode: Mode;
  modelLabel: string;
  /** The center column (T3 placeholder: the current Chat, flexGrow). */
  children: React.ReactNode;
}

/**
 * The dashboard frame (issue #115, spec decisions 1–3, 10): header, panels
 * row at height=bodyRows (menu sidebar · center · right sidebar), gap row,
 * chip footer. Anchoring uses the fixed viewport budget — every panel gets
 * an explicit height and the center column flexes, so all three bottom
 * borders land on the same row without manual sibling-row arithmetic
 * (prototype lesson: let Yoga absorb the remainder).
 */
export function Dashboard({ mode, modelLabel, children }: DashboardProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const { menu, side } = sidebarWidths(viewport);
  const rows = bodyRows(viewport);
  const P = { borderStyle: "round" as const, borderColor: theme.border };

  return (
    <Box flexDirection="column" width="100%">
      {/* header — logo · model (tokens + spinner land with the real data feeds, T6) */}
      <Box
        {...P}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        paddingX={1}
        justifyContent="space-between"
      >
        <Logo />
        <Dim>
          {modelLabel} · {mode === "dev" ? "dev" : "vibe"}
        </Dim>
      </Box>

      {/* panels row — explicit heights, borders align on the same row */}
      <Box flexDirection="row">
        <Box {...P} flexDirection="column" width={menu} height={rows} paddingX={1}>
          <Text bold underline>
            Menu
          </Text>
          {MENU_ENTRIES.map((entry) => (
            <Dim key={entry}>{`  ${entry}`}</Dim>
          ))}
        </Box>
        <Box flexDirection="column" width={centerWidth(viewport)} height={rows}>
          {children}
        </Box>
        {/* right sidebar placeholder — Activity/Workflow/Tokens come with real data (T6) */}
        <Box {...P} width={side} height={rows} />
      </Box>

      {/* gap row */}
      <Box height={1}>
        <Text> </Text>
      </Box>

      {/* footer chips — one row: icon + name in delicate round frames;
          bordered boxes would cost 3 rows against the CHIP_ROWS=1 budget */}
      <Box paddingX={1} gap={1} flexShrink={0} flexWrap="nowrap">
        {fitChips(CHIPS, viewport.columns).map(([icon, name]) => (
          <Text key={name}>
            <Dim>( </Dim>
            <Text color={theme.accent}>{`${icon} `}</Text>
            <Text color={theme.fg}>{name}</Text>
            <Dim> )</Dim>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
