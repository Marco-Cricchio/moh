import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { projectSessionsDir } from "@moh/core";

/**
 * Project notes (#notes-modal): free-text notes scoped to the project,
 * persisted across sessions in the canonical project directory — one
 * JSONL sidecar next to the session log (`~/.moh/projects/<slug>/notes.jsonl`).
 * User-only surface: never enters the event log, never reaches the model.
 * The file is the store, the modal is the editor: a corrupted or
 * hand-edited line degrades to "skipped", never to a failed open.
 */

export interface ProjectNote {
  id: string;
  text: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The canonical notes file for the project (resolved through the core's
 * identity seam — the same directory the session log lives in). */
export function projectNotesPath(cwd: string, home: string): string {
  return join(projectSessionsDir(cwd, home), "notes.jsonl");
}

function coerce(raw: unknown): ProjectNote | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string") return null;
  const now = Date.now();
  return {
    id: typeof r.id === "string" && r.id !== "" ? r.id : randomUUID(),
    text: r.text,
    pinned: r.pinned === true,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : now,
  };
}

/** Read the project's notes. A missing file is an empty list; a malformed
 * line is skipped (one bad line never hides the others). */
export async function readProjectNotes(path: string): Promise<ProjectNote[]> {
  const notes: ProjectNote[] = [];
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return notes; // missing file → empty list
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const note = coerce(JSON.parse(line));
      if (note) notes.push(note);
    } catch {
      // skipped: a hand-edited or truncated line is not a fatal state
    }
  }
  return notes;
}

/** Rewrite the whole store (delete and edit are rewrites; JSONL stays the
 * on-disk shape for greppability). Atomic: tmp file + rename. */
export async function writeProjectNotes(path: string, notes: ProjectNote[]): Promise<void> {
  const body = notes.map((n) => JSON.stringify(n)).join("\n") + (notes.length ? "\n" : "");
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, body);
  await Bun.$`mv ${tmp} ${path}`.quiet();
}

export function newNote(text: string): ProjectNote {
  const now = Date.now();
  return { id: randomUUID(), text, pinned: false, createdAt: now, updatedAt: now };
}

/** Display order: pinned first, then most recently updated first. */
export function sortNotes(notes: ProjectNote[]): ProjectNote[] {
  return [...notes].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
}
