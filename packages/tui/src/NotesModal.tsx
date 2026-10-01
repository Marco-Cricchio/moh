import React, { useEffect, useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dialog, Dim, truncate } from "./ui";
import { dialogWidth, useViewport, windowing } from "./viewport";
import { newNote, projectNotesPath, readProjectNotes, sortNotes, writeProjectNotes, type ProjectNote } from "./notes";

/**
 * The project notes modal (ctrl+n from chat or home): free-text notes,
 * scoped to the project, surviving across sessions. Two modes — a list
 * (pinned first, then most recently updated) and a full-width text editor
 * per note. The editor follows the composer's newline convention plus the
 * owner's decision: enter, shift+enter and ctrl+j all insert a newline;
 * ctrl+s is the only save (esc without changes leaves, with changes asks).
 */

type Mode =
  | { kind: "list" }
  | { kind: "edit"; id: string | null; text: string; original: string };

/** A paste or a bracketed paste can carry newlines; normalize CRLF. */
const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");

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

export interface NotesModalProps {
  cwd: string;
  home: string;
  onClose: () => void;
  /** Test seam: override the store path (defaults to the project dir). */
  notesPath?: string;
}

export function NotesModal({ cwd, home, onClose, notesPath }: NotesModalProps) {
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
    const text = current.text;
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
        if (mode.text !== mode.original) return setConfirm("save");
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
        setMode({ ...mode, text: mode.original });
        return;
      }
      if (key.return || key.ctrl && input === "j") {
        setMode({ ...mode, text: mode.text + "\n" });
        return;
      }
      if (key.backspace || key.delete) {
        setMode({ ...mode, text: mode.text.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl) {
        setMode({ ...mode, text: mode.text + normalize(input) });
        return;
      }
      return;
    }

    // List mode
    if (key.escape) return onClose();
    if (!ordered.length) {
      if (input === "a") return setMode({ kind: "edit", id: null, text: "", original: "" });
      return;
    }
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(ordered.length - 1, c + 1));
    if (input === "a") return setMode({ kind: "edit", id: null, text: "", original: "" });
    if (input === "e" || key.return) {
      const note = ordered[cursor]!;
      return setMode({ kind: "edit", id: note.id, text: note.text, original: note.text });
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
    const lines = mode.text.split("\n");
    const label = mode.id === null ? "new note" : "edit note";
    return (
      <Dialog title="notes" color={theme.accent} width={Math.min(width, 80)} center={false}>
        <Text color={theme.label}>{label}</Text>
        <Text> </Text>
        {lines.slice(-budget + 2).map((line, i) => (
          <Text key={i} wrap="truncate">
            {line === "" ? " " : line}
          </Text>
        ))}
        <Text> </Text>
        {confirm ? (
          <Dim> unsaved changes — esc+s save · esc+d discard · any other key stays </Dim>
        ) : (
          <Dim>{dirty ? " disk write failed — ctrl+s retries · " : ""}enter/shift+enter/ctrl+j newline · ctrl+z restore · ctrl+s save · esc back</Dim>
        )}
      </Dialog>
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
      <Dim> a new · enter/e edit · p pin · d delete · ↑↓ select · esc close</Dim>
    </Dialog>
  );
}
