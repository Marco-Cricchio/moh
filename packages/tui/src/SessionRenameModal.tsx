import React, { useState } from "react";
import { Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/** In-chat session display-name editor. An empty confirmation is the
 * append-only reset event, matching the Home picker and CLI semantics. */
export function SessionRenameModal({ initialName, onRename, onClose }: {
  initialName: string;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [name, setName] = useState(initialName);

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.return || input === "\n") {
      onRename(name);
      onClose();
      return;
    }
    if (key.backspace || key.delete) return setName((value) => value.slice(0, -1));
    if (input && !key.ctrl && !key.meta) setName((value) => value + input);
  });

  return (
    <Dialog title=" rename session " color={theme.accent}>
      <Text color={theme.accent}>name: </Text><Text>{name}</Text><Text color={theme.dim}>▊</Text>
      <Text> </Text>
      <Dim>enter save (empty = reset) · esc cancel</Dim>
    </Dialog>
  );
}
