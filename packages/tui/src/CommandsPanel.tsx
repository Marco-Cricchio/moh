import React from "react";
import { Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * The all-commands panel (issue #33 / style guide §10 Q13): `?` (or
 * ctrl+k in chat) opens the full keybinding list. Context-sensitive
 * footers stay the primary discovery; this is the exhaustive reference.
 */
const COMMANDS: ReadonlyArray<{ area: string; keys: ReadonlyArray<[string, string]> }> = [
  {
    area: "Chat",
    keys: [
      ["enter", "send"],
      ["ctrl+j / shift+enter", "newline"],
      ["ctrl+e", "edit draft in $EDITOR"],
      ["esc", "steer (type to redirect the running turn)"],
      ["esc esc", "stop the running turn"],
      ["ctrl+d", "toggle tool-call detail"],
      ["ctrl+m", "switch vibe / dev mode"],
      ["ctrl+t", "cycle theme"],
      ["ctrl+s", "settings panel"],
      ["ctrl+k / ?", "this command list"],
      ["q", "quit (home)"],
    ],
  },
  {
    area: "Home",
    keys: [
      ["type", "filter sessions or start a new one"],
      ["enter", "open selection / start the typed prompt"],
      ["n", "new session"],
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

export function CommandsPanel({ compact, onClose }: { compact: boolean; onClose: () => void }) {
  const theme = useTheme();
  useInput((input, key) => {
    if (key.escape || input === "?" || key.return) onClose();
  });

  return (
    <Dialog title=" all commands " color={theme.purple} width={compact ? "100%" : "62%"}>
      {COMMANDS.map((group) => (
        <React.Fragment key={group.area}>
          <Text bold color={theme.accent}>
            {group.area}
          </Text>
          {group.keys.map(([k, d]) => (
            <Text key={k}>
              <Text color={theme.accent}>{`  ${k.padEnd(24)}`}</Text>
              <Dim>{d}</Dim>
            </Text>
          ))}
          <Text> </Text>
        </React.Fragment>
      ))}
      <Dim>esc close</Dim>
    </Dialog>
  );
}
