import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./themes";
import { Dim, Logo } from "./ui";
import { Toasts, type Toast } from "./Toasts";
import { bodyRows, centerWidth, sidebarWidths, useViewport } from "./viewport";

/** Left menu entries (T4 wires focus + activation; T3 renders them inert). */
export const MENU_ENTRIES = ["Dashboard", "Sessions", "Wayfinder", "Settings", "Help"] as const;
export type MenuEntry = (typeof MENU_ENTRIES)[number];

/** Footer keybind chips: icon + name, only keys that are live today. */
export const CHIPS: ReadonlyArray<readonly [string, string]> = [
  ["⏎", "send"],
  ["esc", "steer"],
  ["^s", "settings"],
  ["^k", "commands"],
  ["^o", "mode"],
  ["^t", "theme"],
];

/**
 * The session footer's chip list: the dashboard base plus the chat
 * column's contextual hints (detail toggle, scroll-back, streaming stop)
 * merged without duplicates — the chat no longer renders its own tips row.
 * Order matters: `fitChips` drops from the end on narrow widths, so the
 * most essential keys come first.
 */
export function sessionChips(hints: {
  streaming?: boolean;
  atBottom?: boolean;
  detailToggle?: boolean;
}): ReadonlyArray<readonly [string, string]> {
  const out: [string, string][] = [["⏎", "send"]];
  out.push(["esc", hints.streaming ? "esc stop" : "steer"]);
  out.push(["^s", "settings"], ["^k", "commands"], ["^o", "mode"], ["^t", "theme"]);
  if (hints.detailToggle) out.push(["^d", "detail"]);
  if (hints.atBottom === false) out.push(["↑↓", "older"]);
  return out;
}

/** The chip footer row: icon + name in delicate round frames, fit to width. */
export function ChipFooter({ chips = CHIPS }: { chips?: ReadonlyArray<readonly [string, string]> }) {
  const theme = useTheme();
  const viewport = useViewport();
  return (
    <Box paddingX={1} gap={1} flexShrink={0} flexWrap="nowrap">
      {fitChips(chips, viewport.columns).map(([icon, name]) => (
        <Text key={name}>
          <Dim>( </Dim>
          <Text color={theme.accent}>{`${icon} `}</Text>
          <Text color={theme.fg}>{name}</Text>
          <Dim> )</Dim>
        </Text>
      ))}
    </Box>
  );
}

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
  modelLabel: string;
  /** Live token usage for the header (T6); omitted while a session has no model calls yet. */
  tokensLabel?: string;
  /** The center column (T3 placeholder: the current Chat, flexGrow). */
  children: React.ReactNode;
  /**
   * The right sidebar content (Activity/Workflow/Tokens, T6). Absent = vibe
   * mode (spec D6): no right panel, the center column absorbs its width.
   */
  right?: React.ReactNode;
  /** Index of the `❯` selection while the menu has focus (#116); null/undefined = input focus. */
  menuSel?: number | null;
  /** Footer chips override (the session's merged key hints); defaults to CHIPS. */
  chips?: ReadonlyArray<readonly [string, string]>;
  /** Positioned toasts (#119): chat-positioned notices float bottom-center
   * over the chat column, side-positioned (memory) ones at the bottom of the
   * left sidebar, wrapped to its width. */
  toasts?: Toast[];
}

/**
 * The dashboard frame (issue #115, spec decisions 1–3, 10): header, panels
 * row at height=bodyRows (menu sidebar · center · right sidebar), gap row,
 * chip footer. Anchoring uses the fixed viewport budget — every panel gets
 * an explicit height and the center column flexes, so all three bottom
 * borders land on the same row without manual sibling-row arithmetic
 * (prototype lesson: let Yoga absorb the remainder).
 */
export function Dashboard({ modelLabel, tokensLabel, children, right, menuSel, chips, toasts }: DashboardProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const { menu, side } = sidebarWidths(viewport);
  const rows = bodyRows(viewport);
  const P = { borderStyle: "round" as const, borderColor: theme.border };

  return (
    <Box flexDirection="column" width="100%">
      {/* header — logo · model · tokens */}
      <Box
        {...P}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        paddingX={1}
        justifyContent="space-between"
      >
        <Logo />
        <Dim>{tokensLabel ? `${modelLabel} · ${tokensLabel}` : modelLabel}</Dim>
      </Box>

      {/* panels row — explicit heights, borders align on the same row */}
      <Box flexDirection="row">
        <Box {...P} flexDirection="column" width={menu} height={rows} paddingX={1}>
          <Text bold underline>
            Menu
          </Text>
          {MENU_ENTRIES.map((entry, i) =>
            menuSel === i ? (
              <Text key={entry} color={theme.accent} bold>{`❯ ${entry}`}</Text>
            ) : (
              <Dim key={entry}>{`  ${entry}`}</Dim>
            ),
          )}
        </Box>
        <Box flexDirection="column" width={centerWidth(viewport, right !== undefined)} height={rows}>
          {children}
        </Box>
        {/* toast layer (#119): floats above the panels, never shifts layout.
            chat toasts anchor to the center column's bottom edge; memory
            toasts to the menu sidebar's, wrapped to its width. */}
        {toasts !== undefined && (
          <Box position="absolute" width="100%" height={rows} flexDirection="row">
            <Box width={menu} height={rows} flexDirection="column" justifyContent="flex-end">
              <Toasts toasts={toasts.filter((t) => t.position === "side")} wrap={menu - 2} />
            </Box>
            <Box flexGrow={1} flexDirection="column" justifyContent="flex-end" alignItems="center">
              <Toasts toasts={toasts.filter((t) => t.position !== "side")} />
            </Box>
          </Box>
        )}
        {/* right sidebar — Activity/Workflow/Tokens from real session data (T6);
            absent in vibe mode (spec D6): the center column widens instead */}
        {right !== undefined && (
          <Box {...P} width={side} height={rows} paddingX={1}>
            {right}
          </Box>
        )}
      </Box>

      {/* gap row */}
      <Box height={1}>
        <Text> </Text>
      </Box>

      {/* footer chips — one row: icon + name in delicate round frames;
          bordered boxes would cost 3 rows against the CHIP_ROWS=1 budget */}
      <ChipFooter chips={chips} />
    </Box>
  );
}
