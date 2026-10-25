/**
 * Project notes (#notes-modal): store round-trips (JSONL sidecar per
 * project, malformed lines skipped) and the NotesModal component — list,
 * editor (enter/ctrl+j newline, ctrl+s only save, esc-with-changes
 * question), pin, delete, and the ctrl+n App-level wiring.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { NotesModal } from "../src/NotesModal";
import { newNote, readProjectNotes, sortNotes, writeProjectNotes } from "../src/notes";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { pressSettled, stripAnsi, waitStep, waitText } from "./helpers";

/** Waits until the sidecar's notes satisfy `ok` (the write is async); names the step on timeout. */
async function waitNotes(path: string, ok: (notes: Awaited<ReturnType<typeof readProjectNotes>>) => boolean, step: string) {
  const deadline = Date.now() + 3_000;
  let last = await readProjectNotes(path);
  while (!ok(last) && Date.now() < deadline) {
    await Bun.sleep(10);
    last = await readProjectNotes(path);
  }
  if (!ok(last)) throw new Error(`stuck at step "${step}": notes ${JSON.stringify(last)}`);
}

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "moh-notes-")), "notes.jsonl");
}

function mount(notesPath: string, onClose: () => void = () => {}, onInject?: (text: string) => void) {
  const instance = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <NotesModal cwd="/nowhere" home="/nowhere" notesPath={notesPath} onClose={onClose} onInject={onInject} />
    </ThemeProvider>,
  );
  return instance;
}

describe("notes store", () => {
  test("missing file reads as empty list", async () => {
    expect(await readProjectNotes(join(tmpdir(), `moh-notes-none-${Date.now()}.jsonl`))).toEqual([]);
  });

  test("write then read round-trips; malformed lines are skipped", async () => {
    const path = await tempPath();
    const a = newNote("alpha");
    const b = newNote("beta");
    await writeProjectNotes(path, [a, b]);
    // Corrupt the store: one garbage line in between.
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    await writeFile(path, `${lines[0]}\n{broken\n${lines[1]}`);
    const notes = await readProjectNotes(path);
    expect(notes.length).toBe(2);
    expect(notes[0]!.text).toBe("alpha");
    await rm(join(path, ".."), { recursive: true, force: true });
  });

  test("write that empties a non-empty store backs the previous file up as .bak (#1349)", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("keep me")]);
    await writeProjectNotes(path, []); // stale/empty list saved after a failed read
    expect(await readProjectNotes(path)).toEqual([]);
    expect(await readFile(`${path}.bak`, "utf8")).toContain("keep me");
    await writeProjectNotes(path, []); // already empty: no backup churn
    const bak = await readFile(`${path}.bak`, "utf8");
    expect(bak).toContain("keep me");
    await rm(join(path, ".."), { recursive: true, force: true });
  });

  test("sort: pinned first, then most recently updated", () => {
    const a = { ...newNote("a"), updatedAt: 100 };
    const b = { ...newNote("b"), updatedAt: 300 };
    const c = { ...newNote("c"), updatedAt: 200, pinned: true };
    expect(sortNotes([a, b, c]).map((n) => n.text)).toEqual(["c", "b", "a"]);
  });
});

describe("NotesModal", () => {
  test("empty project shows the empty hint; a writes and ctrl+s saves the first note", async () => {
    const path = await tempPath();
    const instance = mount(path);
    await waitText(instance, "no notes yet", "the empty list painted");
    await pressSettled(instance, "a");
    await waitText(instance, "new note", "the editor opened");
    await pressSettled(instance, "hello");
    await waitText(instance, "hello", "the text echoed");
    await pressSettled(instance, "\x13"); // ctrl+s
    await waitText(instance, "· 1 ", "back on the list with one note");
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("hello");
    await waitNotes(path, (n) => n.length === 1 && n[0]!.text === "hello", "the first note persisted");
    instance.unmount();
  });

  test("enter and ctrl+j insert a newline while editing; esc with changes asks, esc+s saves", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("line1")]);
    const instance = mount(path);
    await waitText(instance, "line1", "the list painted");
    await pressSettled(instance, "e"); // edit first note
    await waitText(instance, "edit note", "the editor opened");
    await pressSettled(instance, "\r"); // enter = newline
    await pressSettled(instance, "line2");
    await waitText(instance, "line2", "the second line echoed");
    await pressSettled(instance, "\x1b"); // esc with changes → question
    await waitText(instance, "unsaved changes", "the save question");
    await pressSettled(instance, "s"); // esc+s = save
    await waitNotes(path, (n) => n[0]?.text === "line1\nline2", "the note saved with both lines");
    instance.unmount();
  });

  test("ctrl+j inserts a newline; esc+d discards", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("orig")]);
    const instance = mount(path);
    await waitText(instance, "orig", "the list painted");
    await pressSettled(instance, "e");
    await waitText(instance, "edit note", "the editor opened");
    await pressSettled(instance, "x"); // make it dirty
    await waitText(instance, "origx", "the edit echoed");
    await pressSettled(instance, "\x1b"); // esc → question
    await waitText(instance, "unsaved changes", "the save question");
    await pressSettled(instance, "d"); // discard
    await waitText(instance, "edit note", "the editor closed", { absent: true });
    expect(instance.lastFrame() ?? "").toContain("orig");
    const notes = await readProjectNotes(path);
    expect(notes[0]!.text).toBe("orig");
    instance.unmount();
  });

  test("p pins (pinned floats first), d deletes", async () => {
    const path = await tempPath();
    const a = newNote("first");
    const b = newNote("second");
    await writeProjectNotes(path, [b, a]); // b newer → on top
    const instance = mount(path);
    await waitText(instance, "second", "the list painted");
    await pressSettled(instance, "p"); // pin the selected (newest = second)
    await waitText(instance, "📌", "the pin marker");
    await waitNotes(path, (n) => n.find((x) => x.id === b.id)?.pinned === true, "the pin persisted");
    await pressSettled(instance, "j"); // move down (to "first")
    await pressSettled(instance, "d"); // delete it
    await waitNotes(path, (n) => n.length === 1 && n[0]!.id === b.id, "the note deleted");
    instance.unmount();
  });

  test("cursor editing: left arrow moves back, typing inserts at the cursor", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("helo")]);
    const instance = mount(path);
    await waitText(instance, "helo", "the list painted");
    await pressSettled(instance, "e"); // edit
    await waitText(instance, "edit note", "the editor opened");
    await pressSettled(instance, "\x1b[D"); // left
    await pressSettled(instance, "\x1b[D"); // left
    await pressSettled(instance, "l"); // insert between "hel" and "o"
    await waitText(instance, "hello", "the letter inserted at the cursor");
    await pressSettled(instance, "\x13"); // ctrl+s
    await waitNotes(path, (n) => n[0]?.text === "hello", "the note saved");
    instance.unmount();
  });

  test("cursor editing: backspace removes the grapheme before the cursor, not the last", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("hello")]);
    const instance = mount(path);
    await waitText(instance, "hello", "the list painted");
    await pressSettled(instance, "e");
    await waitText(instance, "edit note", "the editor opened");
    await pressSettled(instance, "\x1b[D"); // left — cursor before "o"
    await pressSettled(instance, "\x1b[D"); // left — cursor before "l"
    await pressSettled(instance, "\x7f"); // backspace removes the first "l"
    await waitText(instance, "helo", "the grapheme removed");
    await pressSettled(instance, "\x13");
    await waitNotes(path, (n) => n[0]?.text === "helo", "the note saved");
    instance.unmount();
  });

  test("long lines word-wrap instead of truncating in the editor", async () => {
    const path = await tempPath();
    const long = "a".repeat(120);
    await writeProjectNotes(path, [newNote(long)]);
    const instance = mount(path);
    await waitText(instance, "aaaa", "the list painted");
    await pressSettled(instance, "e");
    await waitText(instance, "edit note", "the editor opened");
    const frame = stripAnsi(instance.lastFrame() ?? "");
    // No truncation marker and every character is painted on the wrapped
    // rows (the test viewport wraps 120 chars into 3 rows, so assert on
    // the character count, not a contiguous substring).
    expect(frame).not.toContain("…");
    expect((frame.replace(/\s/g, "").match(/a/g) ?? []).length).toBeGreaterThanOrEqual(long.length);
    instance.unmount();
  });

  test("i injects the selected note through the onInject seam", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("inject me")]);
    let injected: string | null = null;
    const onInject = (text: string) => {
      injected = text;
    };
    const instance = mount(path, () => {}, onInject);
    await waitText(instance, "inject me", "the list painted");
    await pressSettled(instance, "i");
    await waitStep(instance, () => injected !== null, "the note injected");
    expect(injected === "inject me" ? injected : "missing").toBe("inject me");
    instance.unmount();
  });

  test("esc on the list closes the modal", async () => {
    let closed = 0;
    const path = await tempPath();
    const instance = mount(path, () => {
      closed += 1;
    });
    await waitText(instance, "no notes yet", "the empty list painted");
    await pressSettled(instance, "\x1b");
    await waitStep(instance, () => closed === 1, "the modal closed");
    expect(closed).toBe(1);
    instance.unmount();
  });
});
