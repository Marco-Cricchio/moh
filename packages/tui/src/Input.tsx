import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";
import { useViewport, windowing } from "./viewport";
import { fuzzyRank } from "./file-index";
import type { CommandEntry } from "./commands";

export interface InputProps {
  placeholder?: string;
  disabled?: boolean;
  onAskCommands?: () => void;
  focused?: boolean;
  /** Incremented by the focused send chip to submit the current draft. */
  submitSignal?: number;
  /** An external, unsent composer prefill (for example a claimed-issue route). */
  prefill?: string;
  /** Slash commands active for this context (workflow-aware), with the
   * popup-facing description and the `[s]`/`[u]` provenance marker
   * (`[s]` built into moh, `[u]` user-defined). The completion popup and
   * its Tab/enter acceptance consult only these; anything missing here is
   * undiscoverable, runnable or not. */
  commands?: readonly CommandEntry[];
  /** Notified on every render with whether the completion popup is open
   * (a slash draft with candidates): the app-level Tab handler defers to
   * the popup so Tab completes instead of focusing the chips. */
  onSuggestionsOpen?: (open: boolean) => void;
  /** #488: the file paths the `@` fuzzy popup lists (relative, from the
   * caller's index — git `ls-files` or a walk). Absent/empty disables
   * the popup; matching happens here, capped. */
  mentionCandidates?: readonly string[];
  /** Vision note 4 (#490): paste seam — called with each completed
   * bracketed paste; returning a path inserts it as an `@path` mention
   * (terminal drag-and-drop), null inserts verbatim. */
  onPastePath?: (paste: string) => string | null;
  onSubmit(text: string): void;
}

interface EditorSnapshot {
  lines: string[];
  line: number;
  column: number;
}

const HISTORY_LIMIT = 100;
/** Cursor blink cadence (ms) — two phase steps per cycle, in sync with the
 * `visible` toggle so on/off each last BLINK_MS. Slightly slower than a
 * classic terminal (~530ms full cycle) per owner preference. */
const BLINK_MS = 400;

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
  while (i < value.length && /\s/.test(value[i])) i++;
  while (i < value.length && !/\s/.test(value[i])) i++;
  return i;
}

/** The completion candidates for a draft: only a single-line `/`-prefix
 * qualifies, and the popup stays open on the exact match so Enter can run
 * it straight from the list. Matching is prefix and case-insensitive;
 * results keep the caller's (alphabetical) order. */
export function slashSuggestions(query: string, commands: readonly CommandEntry[]): CommandEntry[] {
  if (!query.startsWith("/") || query.includes(" ")) return [];
  const lower = query.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(lower))
    .slice(0, 50);
}

/** The `@path` query under the cursor, when the cursor sits in (or right
 * after) an `@` token started at a word boundary. Returns the text after
 * the `@`, or null when no mention popup qualifies. */
export function mentionQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/[\s"]/.test(query)) return null;
  return query;
}

/** Fuzzy-filters the file index for the current `@` query (#488). */
export function mentionSuggestions(query: string | null, candidates: readonly string[]): string[] {
  if (query === null) return [];
  return fuzzyRank(candidates, query);
}

/**
 * Vision note 4: a bracketed paste that IS an existing path (terminal
 * drag-and-drop) becomes an `@path` mention — the full #488 mechanism,
 * popup included. Single-line, shell-unquoted, no whitespace unless the
 * whole paste is one quoted path, and the existence probe is sync-free
 * (the caller pre-checks against the file index / its own stat seam).
 */
export function pasteAsPath(paste: string, isFile: (path: string) => boolean): string | null {
  const trimmed = paste.trim();
  if (!trimmed || trimmed.includes("\n")) return null;
  const unquoted = /^"(.*)"$/s.exec(trimmed)?.[1] ?? /^'(.*)'$/s.exec(trimmed)?.[1] ?? trimmed;
  if (!unquoted || unquoted.includes("\n")) return null;
  return isFile(unquoted) ? unquoted : null;
}

/**
 * Pi-like terminal editor: logical lines, visual wrapping, prompt history,
 * undo/redo, grapheme-aware navigation, bracketed paste, a blinking block
 * cursor, and a scrolling slash-command completion popup (arrows to move,
 * Tab to complete into the draft, Enter to run). Kill-ring behavior is
 * intentionally not included.
 */
export function MultilineInput({
  placeholder,
  disabled,
  onAskCommands,
  focused = true,
  submitSignal = 0,
  prefill,
  commands = [],
  onSuggestionsOpen,
  mentionCandidates = [],
  onPastePath,
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
  // Paste state mirror (ref): a bracketed paste often arrives as several
  // stdin chunks inside ONE React tick — the useState values above are
  // stale for every chunk but the first, so the routing guards below read
  // the ref (updated synchronously) instead.
  const pasteRef = useRef({ inPaste: false, buffer: "" });
  const [scrollOffset, setScrollOffset] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [cursorVisible, setCursorVisible] = useState(true);
  const previousSubmitSignal = useRef(submitSignal);
  const previousPrefill = useRef<string | undefined>(prefill);

  // Blinking block cursor: visible/invisible alternate on a fixed cadence.
  // Any keystroke (handled below through the ref) snaps the phase back to
  // visible, like a terminal editor.
  const cursorVisibleRef = useRef(true);
  useEffect(() => {
    const timer = setInterval(() => {
      cursorVisibleRef.current = !cursorVisibleRef.current;
      setCursorVisible(cursorVisibleRef.current);
    }, BLINK_MS);
    return () => clearInterval(timer);
  }, []);

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
  const wakeCursor = () => {
    cursorVisibleRef.current = true;
    setCursorVisible(true);
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
    const current = visualLineIndexAtCursor();
    if (current >= 0) {
      const maxVisible = Math.max(3, Math.floor(viewport.rows * 0.3));
      setScrollOffset((offset) => Math.max(0, Math.min(Math.max(0, visualLines.length - maxVisible), current < offset ? current : current >= offset + maxVisible ? current - maxVisible + 1 : offset)));
    }
  }, [visualLines, cursorLine, cursorColumn, viewport.rows]);

  /** Each cursor position belongs to exactly one visual row: a wrap boundary
   * belongs to the row beginning there, while a logical-line end belongs to
   * its final visual row. */
  const visualLineIndexAtCursor = () => visualLines.findIndex((item, index) => {
    if (item.logicalLine !== cursorLine || cursorColumn < item.start) return false;
    const end = item.start + item.text.length;
    const finalSegment = visualLines[index + 1]?.logicalLine !== item.logicalLine;
    return cursorColumn < end || finalSegment && cursorColumn === end;
  });

  const replaceText = (text: string, position: "start" | "end" = "end") => {
    const next = text.replace(/\r\n?/g, "\n").split("\n");
    setLines(next.length ? next : [""]);
    const line = position === "start" ? 0 : next.length - 1;
    setCursorLine(line);
    setCursorColumn(position === "start" ? 0 : (next[line] ?? "").length);
    setPreferredColumn(null);
  };

  useEffect(() => {
    if (prefill === undefined || prefill === previousPrefill.current) return;
    previousPrefill.current = prefill;
    replaceText(prefill);
    // A prefill is an external editor command, not user undo history.
    setUndo([]); setRedo([]); setSuggestionIndex(0);
    // replaceText is intentionally read at the prefill edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

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
    setSuggestionIndex(0);
    onSubmit(text);
  };
  useEffect(() => {
    if (submitSignal === previousSubmitSignal.current) return;
    previousSubmitSignal.current = submitSignal;
    submit();
    // submit intentionally reads the draft at the signal edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitSignal]);

  // Stable keypress subscription: the handler closure is recreated every
  // render (state reads, and the blink timer re-renders ~4×/s), and Ink's
  // useInput re-subscribes its stdin listener whenever the callback identity
  // changes — a keystroke arriving inside that churn window would be dropped
  // for good. Routing through a ref keeps one subscription for the mount.
  type KeyHand = Parameters<Parameters<typeof useInput>[0]>[1];
  const handlerRef = useRef<(input: string, key: KeyHand) => void>(() => {});
  handlerRef.current = handleKey;
  const stableHandler = useCallback((input: string, key: KeyHand) => handlerRef.current(input, key), []);
  useInput(stableHandler, { isActive: focused && !disabled });

  /** One keypress: routing, the completion popup, and every editor motion.
   * Lives inside the component (state closures); `stableHandler` above is
   * what Ink actually subscribes. */
  function handleKey(input: string, key: KeyHand) {
    if (disabled) return;
    wakeCursor();
    if (key.escape) return;
    if (input === "?" && lines.join("") === "" && onAskCommands) return onAskCommands();

    // Bracketed paste is atomic and preserves newlines. Ink may strip the
    // leading ESC from the marker, so accept both terminal spellings.
    // An end marker arriving alone (`[201~`, ESC stripped) during an open
    // paste must fall through to the paste buffer below, never claim b1.
    // All guards read pasteRef (synchronous), not the async state.
    if (input.includes("[201~") && !input.includes("[200~") && !pasteRef.current.inPaste && !pasteRef.current.buffer) {
      // Vision note 4: single-chunk paste (start+end in one read).
      const pasted = input.slice(0, input.indexOf("[201~"));
      const asPath = onPastePath ? onPastePath(pasted) : null;
      if (asPath !== null) {
        insertText(asPath.includes(" ") ? `@"${asPath}"` : `@${asPath}`);
      } else {
        insertText(pasted);
      }
      pasteRef.current = { inPaste: false, buffer: "" };
      setPasteBuffer("");
      setInPaste(false);
      return;
    }
    if (input.includes("\x1b[200~") || input.includes("[200~")) {
      pasteRef.current = { inPaste: true, buffer: "" };
      setInPaste(true);
      const started = input.slice(input.indexOf("\x1b[200~") + 6);
      const endMatch = started.match(/\x1b?\[201~/);
      if (endMatch?.index !== undefined) {
        const pasted = started.slice(0, endMatch.index);
        const asPath = onPastePath ? onPastePath(pasted) : null;
        if (asPath !== null) insertText(asPath.includes(" ") ? `@"${asPath}"` : `@${asPath}`);
        else insertText(pasted);
        pasteRef.current = { inPaste: false, buffer: "" };
        setInPaste(false);
        return;
      }
      pasteRef.current.buffer = started;
      setPasteBuffer(started);
      return;
    }
    if (pasteRef.current.inPaste || pasteRef.current.buffer) {
      const all = pasteRef.current.buffer + input;
      const endMatch = all.match(/\x1b?\[201~/);
      if (endMatch?.index === undefined) {
        pasteRef.current.buffer = all;
        return setPasteBuffer(all);
      }
      const pasted = all.slice(0, endMatch.index);
      pasteRef.current = { inPaste: false, buffer: "" };
      setPasteBuffer("");
      setInPaste(false);
      // Vision note 4: a paste that is an existing path (terminal
      // drag-and-drop) inserts as an @mention. Quote when it contains
      // whitespace (#488 quoting rule); otherwise insert verbatim.
      const asPath = onPastePath ? onPastePath(pasted) : null;
      if (asPath !== null) {
        insertText(asPath.includes(" ") ? `@"${asPath}"` : `@${asPath}`);
        return;
      }
      insertText(pasted);
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
    // The completion popups own the arrow keys while open (slash popup on
    // a `/` draft, #488 mention popup on an `@` token): ↑/↓ move the
    // selection, Tab completes it into the draft (focus stays in the
    // textarea — the input consumes the keypress), and Enter accepts the
    // selection exactly like Tab: the completion lands in the textarea
    // followed by a space (closing the popup), so the user types the
    // prompt and the next Enter sends it. Escape closes.
    const queryBeforeKeys = lines.length === 1 ? lines[0] ?? "" : "";
    const slashEntries = slashSuggestions(queryBeforeKeys, commands);
    // #488: the mention query is cursor-scoped — typing `@` mid-draft opens
    // the popup; a space (or moving the cursor out of the token) closes it.
    const mentionQ = mentionQuery(queryBeforeKeys, queryBeforeKeys.length);
    const mentionEntries = mentionSuggestions(mentionQ, mentionCandidates);
    const mentionPopup = mentionEntries.length > 0;
    const slashPopup = slashEntries.length > 0;
    if ((slashPopup || mentionPopup) && (key.upArrow || key.downArrow)) {
      const count = slashPopup ? slashEntries.length : mentionEntries.length;
      setSuggestionIndex((index) => (index + (key.downArrow ? 1 : -1) + count) % count);
      return;
    }
    const acceptSuggestion = () => {
      if (mentionPopup) {
        const chosen = mentionEntries[Math.min(suggestionIndex, mentionEntries.length - 1)] ?? mentionEntries[0]!;
        // Quoted form when the path contains whitespace — the core parser
        // (parseMentions) otherwise splits it at the space.
        const token = /[\s]/.test(chosen) ? `"${chosen}"` : chosen;
        replaceText(`${queryBeforeKeys.slice(0, queryBeforeKeys.length - (mentionQ?.length ?? 0))}${token} `);
      } else {
        const chosen = slashEntries[Math.min(suggestionIndex, slashEntries.length - 1)]?.name ?? slashEntries[0]!.name;
        replaceText(`${chosen} `);
      }
      setSuggestionIndex(0);
    };
    if ((slashPopup || mentionPopup) && key.tab) {
      acceptSuggestion();
      return;
    }
    if (key.return || input === "\r") {
      if (slashPopup || mentionPopup) {
        acceptSuggestion();
        return;
      }
      // Shift+enter (kitty protocol reports it as name "return" + shift) and
      // option+enter (meta) insert a newline instead of submitting — the
      // documented newline key on terminals without the kitty protocol.
      if (key.shift || key.meta) insertText("\n"); else submit();
      return;
    }
    if (input === "\n" || input === "\x0a" || (key.ctrl && input === "j")) { insertText("\n"); return; }
    const line = lines[cursorLine] ?? "";
    if (key.ctrl && input === "a") { setCursorColumn(0); setPreferredColumn(null); return; }
    if (key.ctrl && input === "e") { setCursorColumn(line.length); setPreferredColumn(null); return; }
    if (key.ctrl && key.leftArrow || input === "\x1bb") {
      if (cursorColumn > 0) setCursorColumn(wordLeft(line, cursorColumn));
      else if (cursorLine > 0) { const previous = lines[cursorLine - 1] ?? ""; setCursorLine(cursorLine - 1); setCursorColumn(wordLeft(previous, previous.length)); }
      setPreferredColumn(null); return;
    }
    if (key.ctrl && key.rightArrow || input === "\x1bf") {
      if (cursorColumn < line.length) setCursorColumn(wordRight(line, cursorColumn));
      else if (cursorLine < lines.length - 1) { const next = lines[cursorLine + 1] ?? ""; setCursorLine(cursorLine + 1); setCursorColumn(wordRight(next, 0)); }
      setPreferredColumn(null); return;
    }
    // Horizontal movement breaks a history walk: the recalled entry stays as
    // the working draft and arrows become cursor movement again.
    if (key.leftArrow || key.rightArrow || input === "\x1bb" || input === "\x1bf") setHistoryIndex(-1);
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
      const visualIndex = visualLineIndexAtCursor();
      const atFirstVisualLine = visualIndex <= 0;
      const atLastVisualLine = visualIndex === visualLines.length - 1;
      // Readline walking recall: once entered (historyIndex >= 0), ↑/↓ keep
      // walking the history until a horizontal move or edit breaks the walk.
      if (history.length && historyIndex >= 0) {
        const next = historyIndex + (direction < 0 ? 1 : -1);
        if (next < 0) { if (historyDraft) setEditor(historyDraft); setHistoryIndex(-1); }
        else if (next < history.length) { setHistoryIndex(next); replaceText(history[next]!, "end"); }
        return;
      }
      // Staged edges: while walking a long entry, ↑ first reaches the start
      // of the first visual line and ↓ the end of the last one; only a
      // further press at that edge recalls the history (fish-style readline).
      if (direction < 0 && atFirstVisualLine) {
        if (cursorColumn > 0) { setCursorColumn(0); setPreferredColumn(null); return; }
        if (history.length) { setHistoryDraft(snapshot()); setHistoryIndex(0); replaceText(history[0]!, "end"); }
        return;
      }
      if (direction > 0 && atLastVisualLine) {
        if (cursorColumn < line.length) { setCursorColumn(line.length); setPreferredColumn(null); return; }
        return;
      }
      const current = visualLines[visualIndex]!;
      const target = preferredColumn ?? cursorColumn - current.start;
      const next = visualLines[visualIndex + direction]!;
      setPreferredColumn(target);
      setCursorLine(next.logicalLine);
      setCursorColumn(next.start + Math.min(target, next.text.length));
      return;
    }
    if (input && !key.ctrl && !key.meta) { setSuggestionIndex(0); insertText(input); }
  }

  const query = lines.length === 1 ? lines[0] ?? "" : "";
  const suggestions = slashSuggestions(query, commands);
  // #488: the mention popup is cursor-scoped; on a single-line draft the
  // cursor is the end of the text.
  const mentionEntries = mentionSuggestions(mentionQuery(query, query.length), mentionCandidates);
  // Popup-open state travels to the app (effect, not render): its Tab
  // handler must not race the state update that Tab itself triggers.
  const popupOpen = (suggestions.length > 0 || mentionEntries.length > 0) && focused && !disabled;
  useEffect(() => { onSuggestionsOpen?.(popupOpen); }, [popupOpen, onSuggestionsOpen]);
  const maxVisible = Math.max(3, Math.floor(viewport.rows * 0.3));
  const shown = visualLines.slice(scrollOffset, scrollOffset + maxVisible);
  // The popup scrolls with the selection instead of capping the list.
  const popupRows = Math.min(5, Math.max(suggestions.length, mentionEntries.length));
  const win = windowing(suggestions.length, Math.min(suggestionIndex, Math.max(0, suggestions.length - 1)), popupRows);
  const mentionWin = windowing(mentionEntries.length, Math.min(suggestionIndex, Math.max(0, mentionEntries.length - 1)), popupRows);

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box flexDirection="column">
        {!(lines.length === 1 && lines[0] === "") && shown.map((item, index) => {
          const active = focused && index === visualLineIndexAtCursor();
          const column = active ? cursorColumn - item.start : -1;
          const cursor = active && cursorVisible && !disabled;
          return <Text key={`${item.logicalLine}:${item.start}:${index}`}>{active ? <><Text color={focused && !disabled ? theme.accent : theme.dim} bold>{column === 0 ? "› " : "  "}</Text>{column >= 0 ? <>{item.text.slice(0, column)}{cursor ? <Text inverse bold>{item.text[column] ?? " "}</Text> : <Text color={focused ? theme.accent : theme.dim}>{item.text[column] ?? " "}</Text>}{item.text.slice(column + 1)}</> : item.text}</> : <>{"  "}{item.text}</>}</Text>;
        })}
        {lines.length === 1 && lines[0] === "" && (
          <Text>
            <Text color={focused && !disabled ? theme.accent : theme.dim} bold>› </Text>
            {focused && !disabled && cursorVisible
              ? <Text inverse color={theme.dim}>{placeholder?.[0] ?? " "}</Text>
              : null}
            {placeholder ? <Text color={theme.dim}>{focused && !disabled && cursorVisible ? placeholder.slice(1) : placeholder}</Text> : null}
          </Text>
        )}
      </Box>
      {suggestions.length > 0 && (
        <Box flexDirection="column">
          {win.above > 0 && <Text color={theme.dim}>{`  ↑ ${win.above} more`}</Text>}
          {(() => {
            // Column alignment: every command name pads to the widest name
            // in the filtered list, so markers and descriptions all start
            // on the same columns.
            const nameWidth = Math.max(...suggestions.map((command) => command.name.length));
            return suggestions.slice(win.start, win.start + win.count).map((command, index) => {
              const selected = win.start + index === suggestionIndex;
              // Row grammar: `/command - [s]/[u]: description`, truncated
              // with … when the terminal is too narrow to fit it whole.
              const marker = command.custom ? "u" : "s";
              const full = `${command.name.padEnd(nameWidth)} - [${marker}]: ${command.description}`;
              const budget = viewport.columns - 4;
              const row = full.length > budget ? `${full.slice(0, Math.max(command.name.length + 8, budget - 1))}…` : full;
              return (
                <Text key={command.name} color={selected ? theme.bg : theme.dim} backgroundColor={selected ? theme.accent : undefined}>
                  {selected ? " ▶ " : "   "}{row}
                </Text>
              );
            });
          })()}
          {win.below > 0 && <Text color={theme.dim}>{`  ↓ ${win.below} more (↑↓ scroll)`}</Text>}
        </Box>
      )}
      {suggestions.length === 0 && mentionEntries.length > 0 && (
        <Box flexDirection="column">
          {mentionWin.above > 0 && <Text color={theme.dim}>{`  ↑ ${mentionWin.above} more`}</Text>}
          {mentionEntries.slice(mentionWin.start, mentionWin.start + mentionWin.count).map((path, index) => {
            const selected = mentionWin.start + index === suggestionIndex;
            const budget = viewport.columns - 4;
            const row = path.length > budget ? `${path.slice(0, Math.max(8, budget - 1))}…` : path;
            return (
              <Text key={path} color={selected ? theme.bg : theme.dim} backgroundColor={selected ? theme.accent : undefined}>
                {selected ? " ▶ " : "   "}{row}
              </Text>
            );
          })}
          {mentionWin.below > 0 && <Text color={theme.dim}>{`  ↓ ${mentionWin.below} more (↑↓ scroll)`}</Text>}
        </Box>
      )}
    </Box>
  );
}
