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
 *
 * ADR-0031: an ask raised by an extension (the hook's `ask` outcome) offers
 * yes/no only — never "always", so a false positive cannot disarm the
 * filter that raised it — and carries the extension's own reason as its
 * label.
 */
export function PermissionModal({
  gate,
  mode,
  editor,
}: {
  gate: PermissionGate;
  mode: Mode;
  /** $EDITOR override (settings); falls back to env/$EDITOR/vi. */
  editor?: string;
}) {
  const theme = useTheme();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const view = gate.current;

  useInput((input, key) => {
    if (!view) return;
    if (input === "y" || key.return) return gate.resolve("yes");
    if (!view.extensionAsk) {
      if (view.tool === "browser") {
        // #775: on browser asks the "always" slot is the site-scoped rule.
        if (input === "a" || input === "s") return gate.resolve("always_for_site");
      } else if (input === "a") return gate.resolve("always");
    }
    if (input === "n" || key.escape) return gate.resolve("no");
    if (input === "e" && !view.extensionAsk) editTarget(view.tool, view.args, editor);
  });

  if (!view) return null;

  // #834: enabling a loaded extension is a question about *code*, not about
  // a tool call — the copy says so, and the answer is yes/no (the extension
  // ask slot already drops "always" and "edit").
  const consent = view.tool === "extension" && view.extensionAsk !== undefined;

  return (
    <Dialog title=" permission " color={theme.warn}>
      <Text>
        {consent
          ? "An extension wants to run in this session:"
          : mode === "vibe" ? "Quick check — may I do this?" : "A tool call needs your approval:"}
      </Text>
      {view.extensionAsk ? (
        <Text color={theme.warn}>
          {`${consent ? "extension enable" : "extension ask"}${view.extensionAsk.extension ? ` (${view.extensionAsk.extension})` : ""}${view.extensionAsk.reason ? `: ${view.extensionAsk.reason}` : ""}`}
        </Text>
      ) : null}
      <Text> </Text>
      {view.detail.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {`  ${line}`}
        </Text>
      ))}
      <Text> </Text>
      {view.rulePreview ? (
        <Dim>
          {`  “always” writes the session rule: ${view.rulePreview}${view.tool === "browser" ? " (this site, this session only)" : ""}`}
        </Dim>
      ) : null}
      <Text> </Text>
      <Text>
        <Text color={theme.accent} bold>
          y
        </Text>
        {" yes  "}
        {view.extensionAsk ? null : (
          <>
            <Text color={theme.accent}>a</Text>
            {view.tool === "browser" ? " always for this site  " : " always  "}
            <Text color={theme.accent}>e</Text>
            {" edit  "}
          </>
        )}
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
