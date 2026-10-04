import React, { useEffect, useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dialog, Dim, truncate } from "./ui";
import { dialogWidth, useViewport, windowing } from "./viewport";
import { graphemes, nextColumn, previousColumn } from "./Input";
import { newNote, projectNotesPath, readProjectNotes, sortNotes, writeProjectNotes, type ProjectNote } from "./notes";

/**
 * The project notes modal (ctrl+n from chat or home): free-text notes,
 * scoped to the project, surviving across sessions. Two modes — a list
 * (pinned first, then most recently updated) and a full-width text editor
 * per note (#1180). The editor follows the composer's newline convention
 * plus the owner's decision: enter, shift+enter and ctrl+j all insert a
 * newline; ctrl+s is the only save (esc without changes leaves, with
 * changes asks). Editing is cursor-based — arrows, home/end move inside
 * the note, insert/delete act at the cursor — and long lines word-wrap at
 * the dialog border instead of truncating. In the list, `i` injects the
 * selected note into the chat composer via the App-level prefill seam.
 */

type Mode =
  | { kind: "list" }
  | {
      kind: "edit";
      id: string | null;
      /** Logical lines; the note text is `lines.join("\n")`. */
      lines: string[];
      /** Cursor: logical line index + string column (grapheme-aligned). */
      cl: number;
      cc: number;
      original: string;
    };

/** A paste or a bracketed paste can carry newlines; normalize CRLF. */
const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");

const editText = (mode: Extract<Mode, { kind: "edit" }>): string => mode.lines.join("\n");

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** The visual rows of the editor: every logical line wrapped at `width`
 * columns (grapheme-safe, same rule as the composer), each row carrying
 * its logical line and the string offset it starts at. */
function wrapLines(lines: readonly string[], width: number): Array<{ text: string; line: number; start: number }> {
  const result: Array<{ text: string; line: number; start: number }> = [];
  for (let line = 0; line < lines.length; line++) {
    const value = lines[line] ?? "";
    if (!value) {
      result.push({ text: "", line, start: 0 });
      continue;
    }
    let start = 0;
    for (const part of graphemes(value)) {
      if (part.index + part.segment.length - start > width) {
        result.push({ text: value.slice(start, part.index), line, start });
        start = part.index;
      }
    }
    result.push({ text: value.slice(start), line, start });
  }
  return result;
}

export interface NotesModalProps {
  cwd: string;
  home: string;
  onClose: () => void;
  /** #1180: inject the selected note into the chat composer (the App
   * closes the modal and prefills through its existing prefill seam). */
  onInject?: (text: string) => void;
  /** Test seam: override the store path (defaults to the project dir). */
  notesPath?: string;
}

export function NotesModal({ cwd, home, onClose, onInject, notesPath }: NotesModalProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const path = notesPath ?? projectNotesPath(cwd, home);
  const [notes, setNotes] = useState<ProjectNote[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [confirm, setConfirm] = useState<"save" | "discard" | "stay" | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let live = true;
    readProjectNotes(path).then((loaded) => live && setNotes(sortNotes(loaded)));
    return () => {
      live = false;
    };
  }, [path]);

  const ordered = notes ?? [];
  // Dialog chrome ≈ 7 rows (title, header, blank, footer).
  const budget = Math.max(3, viewport.rows - 9);
  const win = windowing(ordered.length, cursor, budget);
  const width = dialogWidth(viewport);
  // Inner text columns: dialog width minus the round border (2) and
  // paddingX=2 per side.
  const editWidth = Math.max(10, Math.min(width, 80) - 6);
  const editorRows = Math.max(1, budget - 3);

  const persist = async (next: ProjectNote[]) => {
    setNotes(sortNotes(next));
    try {
      await writeProjectNotes(path, next);
      setDirty(false);
    } catch {
      setDirty(true); // the modal stays consistent in memory; save again later
    }
  };

  const saveEdit = (current: Extract<Mode, { kind: "edit" }>) => {
    const text = editText(current);
    const rest = (notes ?? []).filter((n) => n.id !== current.id);
    if (text.trim() === "") {
      // An emptied note is a deleted note — the list is the truth.
      persist(rest);
    } else if (current.id === null) {
      persist([...rest, newNote(text)]);
    } else {
      const existing = (notes ?? []).find((n) => n.id === current.id);
      persist(rest.concat([{ ...(existing ?? newNote("")), id: current.id, text, updatedAt: Date.now() }]));
    }
    setMode({ kind: "list" });
    setConfirm(null);
  };

  useInput((input, key) => {
    if (mode.kind === "edit") {
      if (key.ctrl && input === "c") return; // App owns exit arming
      if (key.ctrl && input === "s") {
        const current = mode;
        if (confirm) return; // wait for the esc answer; ctrl+s is not confirm
        return void saveEdit(current);
      }
      if (key.escape) {
        if (confirm) {
          if (confirm === "save") return void saveEdit(mode);
          if (confirm === "discard") {
            setConfirm(null);
            setDirty(false);
            return setMode({ kind: "list" });
          }
          return setConfirm(null); // stay
        }
        if (editText(mode) !== mode.original) return setConfirm("save");
        return setMode({ kind: "list" });
      }
      // The esc question lives on plain keys: s = save, d = discard, anything else stays.
      if (confirm && input === "s") return void saveEdit(mode);
      if (confirm && input === "d") {
        setConfirm(null);
        setDirty(false);
        return setMode({ kind: "list" });
      }
      if (confirm) return setConfirm(null);
      if (key.ctrl && input === "z") {
        setMode({ ...mode, lines: mode.original === "" ? [""] : mode.original.split("\n"), cl: 0, cc: 0 });
        return;
      }

      const line = mode.lines[mode.cl] ?? "";
      const setEdit = (lines: string[], cl: number, cc: number) =>
        setMode({ ...mode, lines, cl, cc });

      if (key.return || key.ctrl && input === "j") {
        const before = line.slice(0, mode.cc);
        const after = line.slice(mode.cc);
        const next = [...mode.lines.slice(0, mode.cl), before, after, ...mode.lines.slice(mode.cl + 1)];
        return void setEdit(next, mode.cl + 1, 0);
      }
      if (key.backspace || key.delete) {
        if (mode.cc > 0) {
          const start = previousColumn(line, mode.cc);
          return void setEdit(
            mode.lines.map((value, i) => (i === mode.cl ? value.slice(0, start) + value.slice(mode.cc) : value)),
            mode.cl,
            start,
          );
        }
        if (mode.cl > 0) {
          const previous = mode.lines[mode.cl - 1] ?? "";
          const next = [...mode.lines.slice(0, mode.cl - 1), previous + line, ...mode.lines.slice(mode.cl + 1)];
          return void setEdit(next, mode.cl - 1, previous.length);
        }
        return;
      }
      if (key.leftArrow) {
        if (mode.cc === 0 && mode.cl > 0) return void setEdit(mode.lines, mode.cl - 1, (mode.lines[mode.cl - 1] ?? "").length);
        return void setEdit(mode.lines, mode.cl, previousColumn(line, mode.cc));
      }
      if (key.rightArrow) {
        if (mode.cc >= line.length && mode.cl < mode.lines.length - 1) return void setEdit(mode.lines, mode.cl + 1, 0);
        return void setEdit(mode.lines, mode.cl, nextColumn(line, mode.cc));
      }
      if (key.upArrow && mode.cl > 0) {
        const target = mode.lines[mode.cl - 1] ?? "";
        return void setEdit(mode.lines, mode.cl - 1, Math.min(mode.cc, target.length));
      }
      if (key.downArrow && mode.cl < mode.lines.length - 1) {
        const target = mode.lines[mode.cl + 1] ?? "";
        return void setEdit(mode.lines, mode.cl + 1, Math.min(mode.cc, target.length));
      }
      if (key.home) return void setEdit(mode.lines, mode.cl, 0);
      if (key.end) return void setEdit(mode.lines, mode.cl, line.length);
      if (input && !key.ctrl) {
        const normalized = normalize(input);
        const parts = normalized.split("\n");
        let next: string[];
        let cl: number;
        let cc: number;
        if (parts.length === 1) {
          next = mode.lines.map((value, i) => (i === mode.cl ? value.slice(0, mode.cc) + parts[0] + value.slice(mode.cc) : value));
          cl = mode.cl;
          cc = mode.cc + parts[0]!.length;
        } else {
          const before = line.slice(0, mode.cc);
          const after = line.slice(mode.cc);
          next = [...mode.lines.slice(0, mode.cl), before + parts[0]!, ...parts.slice(1, -1), parts.at(-1)! + after, ...mode.lines.slice(mode.cl + 1)];
          cl = mode.cl + parts.length - 1;
          cc = parts.at(-1)!.length;
        }
        return void setEdit(next, cl, cc);
      }
      return;
    }

    // List mode
    if (key.escape) return onClose();
    if (!ordered.length) {
      if (input === "a") return setMode({ kind: "edit", id: null, lines: [""], cl: 0, cc: 0, original: "" });
      return;
    }
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(ordered.length - 1, c + 1));
    if (input === "a") return setMode({ kind: "edit", id: null, lines: [""], cl: 0, cc: 0, original: "" });
    if (input === "e" || key.return) {
      const note = ordered[cursor]!;
      const lines = note.text === "" ? [""] : note.text.split("\n");
      // The cursor opens at the end of the note, like an editor continuing
      // where the text left off.
      return setMode({ kind: "edit", id: note.id, lines, cl: lines.length - 1, cc: (lines[lines.length - 1] ?? "").length, original: note.text });
    }
    if (input === "i") {
      const note = ordered[cursor]!;
      if (note.text.trim() === "") return;
      return void onInject?.(note.text);
    }
    if (input === "p") {
      const note = ordered[cursor]!;
      persist(ordered.map((n) => (n.id === note.id ? { ...n, pinned: !n.pinned, updatedAt: Date.now() } : n)));
      return;
    }
    if (input === "d") {
      const note = ordered[cursor]!;
      persist(ordered.filter((n) => n.id !== note.id));
      setCursor((c) => Math.max(0, Math.min(c, ordered.length - 2)));
      return;
    }
  });

  if (mode.kind === "edit") {
    return (
      <EditView mode={mode} width={editWidth} rows={editorRows} confirm={confirm} dirty={dirty} />
    );
  }

  return (
    <Dialog title="notes" color={theme.accent} center={false}>
      <Text color={theme.label}>
        project notes{notes === null ? "" : ` · ${ordered.length}`} <Dim>(shared across sessions)</Dim>
      </Text>
      <Text> </Text>
      {notes === null ? (
        <Dim>loading…</Dim>
      ) : ordered.length === 0 ? (
        <Dim>no notes yet — press a to write the first one</Dim>
      ) : (
        <>
          {win.above !== 0 ? <Dim> ↑ {win.above} more</Dim> : null}
          {Array.from({ length: win.count }, (_, i) => ordered[win.start + i]!).map((note) => {
            const index = ordered.indexOf(note);
            const selected = index === cursor;
            const first = note.text.split("\n")[0] ?? "";
            const flag = note.pinned ? "📌 " : "  ";
            return (
              <Text key={note.id} color={selected ? theme.accent : undefined}>
                {selected ? "› " : "  "}
                {flag}
                {truncate(first, width - 20)}
                <Dim>{`  ${relativeTime(note.updatedAt)}`}</Dim>
              </Text>
            );
          })}
        </>
      )}
      {win.below !== 0 ? <Dim> ↓ {win.below} more</Dim> : null}
      <Text> </Text>
      <Dim> a new · enter/e edit · i inject to chat · p pin · d delete · ↑↓ select · esc close</Dim>
    </Dialog>
  );
}

/** The cursor-based, word-wrapping editor view (#1180): logical lines wrap
 * at `width` columns, the window scrolls to keep the cursor row visible,
 * and the cursor renders as an inverse block like the composer's. */
function EditView({
  mode,
  width,
  rows,
  confirm,
  dirty,
}: {
  mode: Extract<Mode, { kind: "edit" }>;
  width: number;
  rows: number;
  confirm: "save" | "discard" | "stay" | null;
  dirty: boolean;
}) {
  const theme = useTheme();
  const viewport = useViewport();
  // A corrupted state degrades to one empty row instead of crashing.
  const lines = mode.lines.length ? mode.lines : [""];
  const visual = useMemo(() => wrapLines(lines, width), [lines, width]);
  // The visual row the cursor sits on: the wrap boundary a column falls on
  // belongs to the row starting there; a line end belongs to its last row.
  const cursorVisual = visual.findIndex((item, index) => {
    if (item.line !== mode.cl || mode.cc < item.start) return false;
    const end = item.start + item.text.length;
    const finalSegment = visual[index + 1]?.line !== item.line;
    return mode.cc < end || (finalSegment && mode.cc === end);
  });
  const at = cursorVisual === -1 ? 0 : cursorVisual;
  const start = Math.max(0, Math.min(at, Math.max(0, visual.length - rows)));
  const shown = visual.slice(start, start + rows);
  return (
    <Dialog title="notes" color={theme.accent} width={Math.min(dialogWidth(useViewport()), width + 6)} center={false}>
      <Text color={theme.label}>{mode.id === null ? "new note" : "edit note"}</Text>
      <Text> </Text>
      {shown.map((item, index) => {
        const active = start + index === at;
        const column = active ? mode.cc - item.start : -1;
        return (
          <Text key={`${item.line}:${item.start}:${index}`}>
            {active ? (
              <>
                <Text color={theme.accent} bold>› </Text>
                {item.text.slice(0, column)}
                <Text inverse bold>{item.text[column] ?? " "}</Text>
                {item.text.slice(column + 1)}
              </>
            ) : (
              <>{item.text === "" ? " " : item.text}</>
            )}
          </Text>
        );
      })}
      <Text> </Text>
      {confirm ? (
        <Dim> unsaved changes — esc+s save · esc+d discard · any other key stays </Dim>
      ) : (
        <Dim>{dirty ? " disk write failed — ctrl+s retries · " : ""}←→↑↓ move · enter newline · ctrl+z restore · ctrl+s save · esc back</Dim>
      )}
    </Dialog>
  );
}
