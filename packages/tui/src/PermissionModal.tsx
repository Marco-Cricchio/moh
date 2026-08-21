import React, { useSyncExternalStore } from "react";
import { Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Mode } from "./Chat";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";
import type { PermissionGate } from "./permission-gate";

/**
 * The blocking permission modal (issue #33 / style guide §1 Q5): full
 * command/path detail, choices yes / always (shows the runtime rule it
 * writes) / edit / deny. The turn loop is suspended in the core while
 * this modal is up; answers settle the gate.
 */
export function PermissionModal({
  gate,
  mode,
  compact,
  editor,
}: {
  gate: PermissionGate;
  mode: Mode;
  compact: boolean;
  /** $EDITOR override (settings); falls back to env/$EDITOR/vi. */
  editor?: string;
}) {
  const theme = useTheme();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const view = gate.current;

  useInput((input, key) => {
    if (!view) return;
    if (input === "y" || key.return) return gate.resolve("yes");
    if (input === "a") return gate.resolve("always");
    if (input === "n" || key.escape) return gate.resolve("no");
    if (input === "e") editTarget(view.tool, view.args, editor);
  });

  if (!view) return null;

  return (
    <Dialog
      title=" permission "
      color={theme.warn}
      width={compact ? "100%" : "62%"}
    >
      <Text>{mode === "vibe" ? "Quick check — may I do this?" : "A tool call needs your approval:"}</Text>
      <Text> </Text>
      {view.detail.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {`  ${line}`}
        </Text>
      ))}
      <Text> </Text>
      {view.rulePreview ? (
        <Dim>{`  “always” writes the session rule: ${view.rulePreview}`}</Dim>
      ) : null}
      <Text> </Text>
      <Text>
        <Text color={theme.accent} bold>
          y
        </Text>
        {" yes  "}
        <Text color={theme.accent}>a</Text>
        {" always  "}
        <Text color={theme.accent}>e</Text>
        {" edit  "}
        <Text color={theme.accent}>n</Text>
        {" no"}
      </Text>
    </Dialog>
  );
}

/**
 * "edit": open the target file in $EDITOR so the user can inspect/adjust
 * it before deciding. For tools without a path there is nothing to edit —
 * the modal simply stays up.
 */
function editTarget(tool: string, args: unknown, editorOverride?: string): void {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.path !== "string") return;
  if (!existsSync(a.path)) return;
  const editor = editorOverride || process.env.EDITOR || "vi";
  try {
    spawnSync(editor, [a.path], { stdio: "inherit" });
  } catch {
    // best effort — the modal is still up for y/a/n
  }
}
