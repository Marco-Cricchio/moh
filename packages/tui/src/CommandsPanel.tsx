import React, { useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";
import { useViewport } from "./viewport";

/**
 * The all-commands panel (issue #33 / style guide §10 Q13): `?` (or
 * ctrl+k in chat) opens the full keybinding list. Context-sensitive
 * footers stay the primary discovery; this is the exhaustive reference.
 * Height-aware (#64): on short terminals the flattened list scrolls
 * (↑↓) inside a cursor-free window with more-indicators.
 */
export const COMMANDS: ReadonlyArray<{ area: string; keys: ReadonlyArray<[string, string]> }> = [
  {
    area: "Chat",
    keys: [
      ["enter", "send"],
      ["shift+enter", "newline (option+enter / ctrl+j on legacy terminals)"],
      ["ctrl+a/e", "line start / line end"],
      ["esc", "steer (type to redirect the running turn)"],
      ["esc esc", "stop the running turn"],
      ["ctrl+d", "toggle tool-call detail"],
      ["ctrl+o", "switch vibe / dev mode"],
      ["ctrl+t", "cycle theme"],
      ["ctrl+y", "cycle thinking level"],
      ["ctrl+s", "settings panel"],
      ["ctrl+k / ?", "this command list"],
      ["/workflow on|off", "toggle workflow mode (skills + frontier)"],
      ["ctrl+f", "frontier panel (workflow mode on)"],
      ["q", "quit (home)"],
    ],
  },
  {
    area: "Slash commands (type / for the completion popup)",
    keys: [
      ["/ask-moh", "router over moh skills + docs"],
      ["/commands", "this command list"],
      ["/compact", "force context compaction (same producer as the auto trigger)"],
      ["/mode", "switch vibe / dev mode"],
      ["/model", "model picker (or /model <ref>)"],
      ["/reload", "hot-reload moh.json + user config"],
      ["/settings", "settings panel"],
      ["/theme", "cycle the color theme"],
      ["/thinking", "reasoning display + thinking level"],
      ["/wayfinder", "frontier panel (workflow on)"],
      ["/workflow", "toggle workflow mode"],
    ],
  },
  {
    area: "Home",
    keys: [
      ["type", "filter sessions or start a new one"],
      ["enter", "open selection / start the typed prompt"],
      ["n", "new session"],
      ["r / →", "rename the selected session (enter confirm, empty = reset, esc cancel)"],
      ["s", "settings panel"],
      ["?", "this command list"],
    ],
  },
  {
    area: "Modals",
    keys: [
      ["y / a / e / n", "permission: yes / always / edit / no"],
      ["esc", "close panel (deny when permission asks)"],
    ],
  },
];

type Line = { kind: "group"; area: string } | { kind: "key"; name: string; desc: string };

const LINES: ReadonlyArray<Line> = COMMANDS.flatMap((group) => [
  { kind: "group", area: group.area },
  ...group.keys.map(([name, desc]) => ({ kind: "key" as const, name, desc })),
]);

import { windowing } from "./viewport";

export function CommandsPanel({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const viewport = useViewport();
  const [cursor, setCursor] = useState(0);

  // Dialog chrome (title, spacing, footer, borders) ≈ 6 rows.
  const win = windowing(LINES.length, cursor, Math.max(4, viewport.rows - 6));

  useInput((input, key) => {
    if (key.escape || input === "?" || key.return) onClose();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(LINES.length - 1, c + 1));
  });

  return (
    <Dialog title=" all commands " color={theme.purple} center={false}>
      {win.above > 0 && <Dim>{` ↑ ${win.above} more`}</Dim>}
      {LINES.slice(win.start, win.start + win.count).map((line, i) =>
        line.kind === "group" ? (
          <Text key={`g-${line.area}-${win.start + i}`} bold color={theme.accent}>
            {line.area}
          </Text>
        ) : (
          <Text key={`${line.name}-${win.start + i}`} wrap="truncate-end">
            <Text color={theme.accent}>{`  ${line.name.padEnd(24)}`}</Text>
            <Dim>{line.desc}</Dim>
          </Text>
        ),
      )}
      {win.below > 0 && <Dim>{` ↓ ${win.below} more (↑↓ scroll)`}</Dim>}
      <Dim>esc close</Dim>
    </Dialog>
  );
}
