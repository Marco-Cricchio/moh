import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { useTheme } from "./themes";

export interface InputProps {
  /** Placeholder shown when the (single) line is empty. */
  placeholder?: string;
  /** Override the send hint (e.g. while steering). */
  disabled?: boolean;
  /** `?` on an empty draft opens the all-commands panel instead of typing. */
  onAskCommands?: () => void;
  /** False while the dashboard menu owns the keyboard (#116): the input hears nothing. */
  focused?: boolean;
  /** Reports the current draft line count (#117): the chat window shrinks so a multiline draft never makes the frame scroll. */
  onLinesChange?: (lines: number) => void;
  onSubmit(text: string): void;
}

/**
 * Multiline input (#14 Q2): enter sends; ctrl+j inserts a newline
 * (shift+enter too, where the kitty keyboard protocol reports it); ctrl+e
 * opens $EDITOR for long text. The box is the only bordered element at rest
 * and spans the full terminal width.
 */
export function MultilineInput({ placeholder, disabled, onAskCommands, focused = true, onLinesChange, onSubmit }: InputProps) {
  const theme = useTheme();
  const [lines, setLines] = useState<string[]>([""]);
  const [cursorLine, setCursorLine] = useState(0);

  useEffect(() => {
    onLinesChange?.(lines.length);
  }, [lines.length, onLinesChange]);

  const submit = () => {
    const text = lines.join("\n").trim();
    setLines([""]);
    setCursorLine(0);
    if (text) onSubmit(text);
  };

  const insertNewline = () => {
    setLines((ls) => {
      const next = [...ls];
      next.splice(cursorLine + 1, 0, "");
      return next;
    });
    setCursorLine((l) => l + 1);
  };

  useInput(
    (input, key) => {
      if (disabled) return;
      if (key.escape) return; // owned by the chat screen (steer/stop)
    if (input === "?" && lines.join("") === "" && onAskCommands) return onAskCommands();
    if (key.return || input === "\r") {
      // option/alt+enter (\x1b\r — Terminal.app/iTerm2 send it) is a
      // newline too: shift+enter is indistinguishable from Enter there
      // (no kitty protocol), but option+enter carries its own sequence.
      if (key.shift || key.meta) insertNewline();
      else submit();
      return;
    }
    // ctrl+j newline. Ink parses its \n byte as name "enter", ctrl false,
    // input "\n" — it must NOT fall into the submit branch above (a real
    // Enter arrives as \r / key.return), or ctrl+j would send the draft.
    if (input === "\n" || input === "\x0a" || (key.ctrl && input === "j")) {
      insertNewline();
      return;
    }
    if (key.ctrl && input === "e") {
      editInEditor(lines, setLines, setCursorLine);
      return;
    }
    if (key.backspace || key.delete) {
      const line = lines[cursorLine] ?? "";
      if (line === "") {
        if (cursorLine > 0) {
          setLines((ls) => {
            const next = [...ls];
            next.splice(cursorLine, 1);
            return next;
          });
          setCursorLine(cursorLine - 1);
        }
      } else {
        setLines((ls) => {
          const next = [...ls];
          next[cursorLine] = line.slice(0, -1);
          return next;
        });
      }
      return;
    }
    if (key.upArrow && cursorLine > 0) return setCursorLine(cursorLine - 1);
    if (key.downArrow && cursorLine < lines.length - 1) return setCursorLine(cursorLine + 1);
    if (input && !key.ctrl && !key.meta) {
      setLines((ls) => {
        const next = [...ls];
        next[cursorLine] = (next[cursorLine] ?? "") + input;
        return next;
      });
    }
    },
    { isActive: focused && !disabled },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={focused && !disabled ? theme.accent : theme.border}
      width="100%"
      paddingX={1}
    >
      <Text color={focused && !disabled ? theme.accent : theme.dim} bold>
        ›{" "}
      </Text>
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i}>
            {line}
            {i === cursorLine && lines.length === 1 && line === "" ? (
              <Text color={theme.dim}>{placeholder ?? "type…"}</Text>
            ) : null}
            {i === cursorLine ? <Text color={theme.dim}>▊</Text> : null}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** ctrl+e: round-trip the draft through $EDITOR (vim fallback). */
function editInEditor(
  lines: string[],
  setLines: (fn: (ls: string[]) => string[]) => void,
  setCursorLine: (n: number) => void,
): void {
  const file = join(tmpdir(), `moh-input-${Date.now()}.md`);
  writeFileSync(file, lines.join("\n"));
  const editor = process.env.EDITOR || "vi";
  try {
    spawnSync(editor, [file], { stdio: "inherit" });
    const text = readFileSync(file, "utf8").replace(/\n$/, "");
    const next = text === "" ? [""] : text.split("\n");
    setLines(() => next);
    setCursorLine(next.length - 1);
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // best effort
    }
  }
}
