import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { useTheme } from "./themes";
import { useViewport } from "./viewport";

export interface InputProps {
  placeholder?: string;
  disabled?: boolean;
  onAskCommands?: () => void;
  focused?: boolean;
  /** Incremented by the focused send chip to submit the current draft. */
  submitSignal?: number;
  /** Slash commands active for this context (`/`-prefixed, workflow-aware).
   * The completion list and its Tab/enter acceptance consult only these;
   * anything missing here is undiscoverable, runnable or not. */
  commands?: readonly string[];
  onSubmit(text: string): void;
}

interface EditorSnapshot {
  lines: string[];
  line: number;
  column: number;
}

const HISTORY_LIMIT = 100;

function graphemes(value: string): Intl.SegmentData[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
}

function previousColumn(value: string, column: number): number {
  return graphemes(value).filter((part) => part.index < column).at(-1)?.index ?? 0;
}

function nextColumn(value: string, column: number): number {
  const next = graphemes(value).find((part) => part.index >= column);
  return next ? next.index + next.segment.length : value.length;
}

function wordLeft(value: string, column: number): number {
  let i = Math.max(0, column);
  while (i > 0 && /\s/.test(value[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
  return i;
}

function wordRight(value: string, column: number): number {
  let i = Math.min(value.length, column);
  while (i < value.length && /\s/.test(value[i]!)) i++;
  while (i < value.length && !/\s/.test(value[i]!)) i++;
  return i;
}

/**
 * Pi-like terminal editor: logical lines, visual wrapping, prompt history,
 * undo/redo, grapheme-aware navigation, bracketed paste, and a small slash
 * command completion list. Kill-ring behavior is intentionally not included.
 */
export function MultilineInput({
  placeholder,
  disabled,
  onAskCommands,
  focused = true,
  submitSignal = 0,
  commands = [],
  onSubmit,
}: InputProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const [lines, setLines] = useState<string[]>([""]);
  const [cursorLine, setCursorLine] = useState(0);
  const [cursorColumn, setCursorColumn] = useState(0);
  const [preferredColumn, setPreferredColumn] = useState<number | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState<EditorSnapshot | null>(null);
  const [undo, setUndo] = useState<EditorSnapshot[]>([]);
  const [redo, setRedo] = useState<EditorSnapshot[]>([]);
  const [pasteBuffer, setPasteBuffer] = useState("");
  const [inPaste, setInPaste] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const previousSubmitSignal = useRef(submitSignal);

  const snapshot = (): EditorSnapshot => ({ lines: [...lines], line: cursorLine, column: cursorColumn });
  const setEditor = (next: EditorSnapshot) => {
    setLines(next.lines.length ? next.lines : [""]);
    setCursorLine(Math.min(next.line, Math.max(0, next.lines.length - 1)));
    setCursorColumn(next.column);
    setPreferredColumn(null);
  };
  const record = () => {
    setUndo((stack) => [...stack.slice(-(HISTORY_LIMIT - 1)), snapshot()]);
    setRedo([]);
  };

  const wrapWidth = Math.max(10, viewport.columns - 8);
  const visualLines = useMemo(() => {
    const result: Array<{ text: string; logicalLine: number; start: number }> = [];
    for (let line = 0; line < lines.length; line++) {
      const value = lines[line] ?? "";
      if (!value) {
        result.push({ text: "", logicalLine: line, start: 0 });
        continue;
      }
      let start = 0;
      for (const part of graphemes(value)) {
        if (part.index + part.segment.length - start > wrapWidth) {
          result.push({ text: value.slice(start, part.index), logicalLine: line, start });
          start = part.index;
        }
      }
      result.push({ text: value.slice(start), logicalLine: line, start });
    }
    return result;
  }, [lines, wrapWidth]);

  useEffect(() => {
    const current = visualLines.findIndex((item) => item.logicalLine === cursorLine && cursorColumn >= item.start && cursorColumn <= item.start + item.text.length);
    if (current >= 0) {
      const maxVisible = Math.max(3, Math.floor(viewport.rows * 0.3));
      setScrollOffset((offset) => Math.max(0, Math.min(Math.max(0, visualLines.length - maxVisible), current < offset ? current : current >= offset + maxVisible ? current - maxVisible + 1 : offset)));
    }
  }, [visualLines, cursorLine, cursorColumn, viewport.rows]);

  const replaceText = (text: string, position: "start" | "end" = "end") => {
    const next = text.replace(/\r\n?/g, "\n").split("\n");
    setLines(next.length ? next : [""]);
    const line = position === "start" ? 0 : next.length - 1;
    setCursorLine(line);
    setCursorColumn(position === "start" ? 0 : (next[line] ?? "").length);
    setPreferredColumn(null);
  };

  const insertText = (text: string) => {
    if (!text) return;
    record();
    const normalized = text.replace(/\r\n?/g, "\n");
    const inserted = normalized.split("\n");
    const current = lines[cursorLine] ?? "";
    const before = current.slice(0, cursorColumn);
    const after = current.slice(cursorColumn);
    const next = inserted.length === 1
      ? [...lines.slice(0, cursorLine), before + inserted[0] + after, ...lines.slice(cursorLine + 1)]
      : [...lines.slice(0, cursorLine), before + inserted[0], ...inserted.slice(1, -1), (inserted.at(-1) ?? "") + after, ...lines.slice(cursorLine + 1)];
    setLines(next);
    setCursorLine(cursorLine + inserted.length - 1);
    setCursorColumn(inserted.length === 1 ? cursorColumn + inserted[0]!.length : inserted.at(-1)!.length);
    setPreferredColumn(null);
  };

  const submit = () => {
    const text = lines.join("\n").trim();
    if (!text) return;
    setHistory((items) => [text, ...items.filter((item) => item !== text)].slice(0, HISTORY_LIMIT));
    setHistoryIndex(-1);
    setHistoryDraft(null);
    setLines([""]); setCursorLine(0); setCursorColumn(0); setScrollOffset(0);
    setUndo([]); setRedo([]);
    onSubmit(text);
  };
  useEffect(() => {
    if (submitSignal === previousSubmitSignal.current) return;
    previousSubmitSignal.current = submitSignal;
    submit();
    // submit intentionally reads the draft at the signal edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitSignal]);

  useInput((input, key) => {
    if (disabled) return;
    if (key.escape) return;
    if (input === "?" && lines.join("") === "" && onAskCommands) return onAskCommands();

    // Bracketed paste is atomic and preserves newlines. Ink may strip the
    // leading ESC from the marker, so accept both terminal spellings.
    if (input.includes("[201~") && !input.includes("[200~")) {
      insertText(input.slice(0, input.indexOf("[201~")));
      setPasteBuffer("");
      setInPaste(false);
      return;
    }
    if (input.includes("\x1b[200~") || input.includes("[200~")) {
      setInPaste(true);
      const started = input.slice(input.indexOf("\x1b[200~") + 6);
      const endMatch = started.match(/\x1b?\[201~/);
      if (endMatch?.index !== undefined) { insertText(started.slice(0, endMatch.index)); setInPaste(false); return; }
      setPasteBuffer(started);
      return;
    }
    if (pasteBuffer || inPaste) {
      const all = pasteBuffer + input;
      const endMatch = all.match(/\x1b?\[201~/);
      if (endMatch?.index === undefined) return setPasteBuffer(all);
      insertText(all.slice(0, endMatch.index));
      setPasteBuffer("");
      setInPaste(false);
      return;
    }

    if (key.ctrl && input === "z") {
      const previous = undo.at(-1); if (!previous) return;
      setRedo((stack) => [...stack, snapshot()]); setUndo((stack) => stack.slice(0, -1)); setEditor(previous); return;
    }
    if ((key.ctrl && input === "y") || (key.ctrl && key.shift && input === "z")) {
      const next = redo.at(-1); if (!next) return;
      setUndo((stack) => [...stack, snapshot()]); setRedo((stack) => stack.slice(0, -1)); setEditor(next); return;
    }
    const queryBeforeKeys = lines.length === 1 ? lines[0] ?? "" : "";
    const availableSuggestions = queryBeforeKeys.startsWith("/") ? commands.filter((command) => command.startsWith(queryBeforeKeys)).slice(0, 5) : [];
    if (availableSuggestions.length > 0 && (key.upArrow || key.downArrow)) {
      setSuggestionIndex((index) => (index + (key.downArrow ? 1 : -1) + availableSuggestions.length) % availableSuggestions.length);
      return;
    }
    if (availableSuggestions.length > 0 && key.tab) {
      const completion = availableSuggestions[suggestionIndex] ?? availableSuggestions[0]!;
      replaceText(completion);
      return;
    }
    if (key.return || input === "\r") {
      if (availableSuggestions.length > 0 && suggestionIndex > 0) {
        replaceText(availableSuggestions[suggestionIndex]!);
      } else if (key.shift || key.meta) insertText("\n"); else submit();
      return;
    }
    if (input === "\n" || input === "\x0a" || (key.ctrl && input === "j")) { insertText("\n"); return; }
    const line = lines[cursorLine] ?? "";
    if (key.ctrl && input === "a") { setCursorColumn(0); setPreferredColumn(null); return; }
    if (key.ctrl && input === "e") { setCursorColumn(line.length); setPreferredColumn(null); return; }
    if (key.ctrl && key.leftArrow) { setCursorColumn(wordLeft(line, cursorColumn)); setPreferredColumn(null); return; }
    if (key.ctrl && key.rightArrow) { setCursorColumn(wordRight(line, cursorColumn)); setPreferredColumn(null); return; }
    if (input === "\x1bb") { setCursorColumn(wordLeft(line, cursorColumn)); setPreferredColumn(null); return; }
    if (input === "\x1bf") { setCursorColumn(wordRight(line, cursorColumn)); setPreferredColumn(null); return; }
    if (key.leftArrow) {
      if (cursorColumn === 0 && cursorLine > 0) { setCursorLine(cursorLine - 1); setCursorColumn((lines[cursorLine - 1] ?? "").length); }
      else setCursorColumn(previousColumn(line, cursorColumn));
      setPreferredColumn(null); return;
    }
    if (key.rightArrow) {
      if (cursorColumn >= line.length && cursorLine < lines.length - 1) { setCursorLine(cursorLine + 1); setCursorColumn(0); }
      else setCursorColumn(nextColumn(line, cursorColumn));
      setPreferredColumn(null); return;
    }
    if (key.home) { setCursorColumn(0); setPreferredColumn(null); return; }
    if (key.end) { setCursorColumn(line.length); setPreferredColumn(null); return; }
    if (key.backspace || key.delete || input === "\x7f") {
      // Some terminal/Ink combinations classify the raw DEL byte as
      // `delete`, although it is the user's Backspace key. Prefer the raw
      // byte's conventional meaning so Backspace always deletes left.
      // Ink reports the terminal's Backspace/DEL sequence as `delete` on
      // some terminals, so both flags are treated as backward deletion here.
      const backward = key.backspace || key.delete || input === "\x7f";
      // Backspace removes the grapheme directly before the cursor, never the
      // character currently under it.
      if (backward && cursorColumn > 0) {
        const start = previousColumn(line, cursorColumn);
        record();
        setLines((ls) => ls.map((value, i) => i === cursorLine ? value.slice(0, start) + value.slice(cursorColumn) : value));
        setCursorColumn(start);
        setPreferredColumn(null);
        return;
      }
      // At the beginning of a logical line, Backspace joins it to the
      // previous line and places the cursor at the join.
      if (backward && cursorLine > 0) {
        const previous = lines[cursorLine - 1] ?? "";
        record();
        setLines((ls) => [...ls.slice(0, cursorLine - 1), previous + line, ...ls.slice(cursorLine + 1)]);
        setCursorLine(cursorLine - 1);
        setCursorColumn(previous.length);
        setPreferredColumn(null);
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? -1 : 1;
      if (history.length && lines.length === 1 && (key.upArrow && cursorLine === 0 || key.downArrow && cursorLine === lines.length - 1) && (cursorColumn === 0 || cursorColumn === line.length || historyIndex >= 0)) {
        if (historyIndex < 0) { setHistoryDraft(snapshot()); setHistoryIndex(0); replaceText(history[0]!, "end"); }
        else { const next = historyIndex + (direction < 0 ? 1 : -1); if (next < 0) { if (historyDraft) setEditor(historyDraft); setHistoryIndex(-1); } else if (next < history.length) { setHistoryIndex(next); replaceText(history[next]!, "end"); } }
        return;
      }
      if (direction < 0 && cursorLine === 0) return;
      if (direction > 0 && cursorLine === lines.length - 1) return;
      const target = preferredColumn ?? cursorColumn; const nextLine = cursorLine + direction;
      setPreferredColumn(target); setCursorLine(nextLine); setCursorColumn(Math.min(target, (lines[nextLine] ?? "").length)); return;
    }
    if (input && !key.ctrl && !key.meta) { setSuggestionIndex(0); insertText(input); }
  }, { isActive: focused && !disabled });

  const query = lines.length === 1 ? lines[0] ?? "" : "";
  const suggestions = query.startsWith("/") ? commands.filter((command) => command.startsWith(query)).slice(0, 5) : [];
  const maxVisible = Math.max(3, Math.floor(viewport.rows * 0.3));
  const shown = visualLines.slice(scrollOffset, scrollOffset + maxVisible);

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box flexDirection="column">
        {!(lines.length === 1 && lines[0] === "") && shown.map((item, index) => {
          const active = focused && item.logicalLine === cursorLine && cursorColumn >= item.start && cursorColumn <= item.start + item.text.length;
          const column = active ? cursorColumn - item.start : -1;
          return <Text key={`${item.logicalLine}:${item.start}:${index}`}>{active ? <><Text color={focused && !disabled ? theme.accent : theme.dim} bold>{column === 0 ? "› " : "  "}</Text>{item.text.slice(0, column)}{column >= 0 ? <Text inverse>{column < item.text.length ? item.text[column] : " "}</Text> : null}{item.text.slice(column + 1)}</> : <>{"  "}{item.text}</>}</Text>;
        })}
        {lines.length === 1 && lines[0] === "" && <Text><Text color={focused && !disabled ? theme.accent : theme.dim} bold>› </Text><Text color={theme.dim}>{placeholder ?? "type…"}</Text></Text>}
      </Box>
      {suggestions.length > 0 && <Text color={theme.dim}>{suggestions.join("  ")}</Text>}
    </Box>
  );
}

