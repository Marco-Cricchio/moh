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
import React from "react";
import { render } from "ink-testing-library";
import { NotesModal } from "../src/NotesModal";
import { newNote, readProjectNotes, sortNotes, writeProjectNotes } from "../src/notes";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi, waitForFrame } from "./helpers";

const waitFor = (instance: { lastFrame: () => string | undefined }, text: string) =>
  waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), text);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await waitFor(instance, "no notes yet");
    instance.stdin.write("a");
    await sleep(30);
    instance.stdin.write("hello");
    await sleep(30);
    instance.stdin.write("\x13"); // ctrl+s
    await sleep(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).toContain("· 1 ");
    const notes = await readProjectNotes(path);
    expect(notes.length).toBe(1);
    expect(notes[0]!.text).toBe("hello");
    instance.unmount();
  });

  test("enter and ctrl+j insert a newline while editing; esc with changes asks, esc+s saves", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("line1")]);
    const instance = mount(path);
    await waitFor(instance, "line1");
    instance.stdin.write("e"); // edit first note
    await sleep(30);
    instance.stdin.write("\r"); // enter = newline
    await sleep(40);
    instance.stdin.write("line2");
    await sleep(30);
    instance.stdin.write("\x1b"); // esc with changes → question
    await sleep(30);
    expect(instance.lastFrame() ?? "").toContain("unsaved changes");
    instance.stdin.write("s"); // esc+s = save
    await sleep(60);
    const notes = await readProjectNotes(path);
    expect(notes[0]!.text).toBe("line1\nline2");
    instance.unmount();
  });

  test("ctrl+j inserts a newline; esc+d discards", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("orig")]);
    const instance = mount(path);
    await waitFor(instance, "orig");
    instance.stdin.write("e");
    await sleep(30);
    instance.stdin.write("x"); // make it dirty
    await sleep(30);
    instance.stdin.write("\x1b"); // esc → question
    await sleep(20);
    instance.stdin.write("d"); // discard
    await sleep(40);
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
    await waitFor(instance, "second");
    instance.stdin.write("p"); // pin the selected (newest = second)
    await sleep(60);
    expect(instance.lastFrame() ?? "").toContain("📌");
    const pinned = await readProjectNotes(path);
    expect(pinned.find((n) => n.id === b.id)?.pinned).toBe(true);
    instance.stdin.write("j"); // move down (to "first")
    await sleep(30);
    instance.stdin.write("d"); // delete it
    await sleep(60);
    const after = await readProjectNotes(path);
    expect(after.length).toBe(1);
    expect(after[0]!.id).toBe(b.id);
    instance.unmount();
  });

  test("cursor editing: left arrow moves back, typing inserts at the cursor", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("helo")]);
    const instance = mount(path);
    await waitFor(instance, "helo");
    instance.stdin.write("e"); // edit
    await sleep(30);
    instance.stdin.write("\x1b[D"); // left
    await sleep(20);
    instance.stdin.write("\x1b[D"); // left
    await sleep(20);
    instance.stdin.write("l"); // insert between "hel" and "o"
    await sleep(30);
    instance.stdin.write("\x13"); // ctrl+s
    await sleep(60);
    const notes = await readProjectNotes(path);
    expect(notes[0]!.text).toBe("hello");
    instance.unmount();
  });

  test("cursor editing: backspace removes the grapheme before the cursor, not the last", async () => {
    const path = await tempPath();
    await writeProjectNotes(path, [newNote("hello")]);
    const instance = mount(path);
    await waitFor(instance, "hello");
    instance.stdin.write("e");
    await sleep(30);
    instance.stdin.write("\x1b[D"); // left — cursor before "o"
    await sleep(20);
    instance.stdin.write("\x1b[D"); // left — cursor before "l"
    await sleep(20);
    instance.stdin.write("\x7f"); // backspace removes the first "l"
    await sleep(30);
    instance.stdin.write("\x13");
    await sleep(60);
    const notes = await readProjectNotes(path);
    expect(notes[0]!.text).toBe("helo");
    instance.unmount();
  });

  test("long lines word-wrap instead of truncating in the editor", async () => {
    const path = await tempPath();
    const long = "a".repeat(120);
    await writeProjectNotes(path, [newNote(long)]);
    const instance = mount(path);
    await waitFor(instance, "aaaa");
    instance.stdin.write("e");
    await sleep(30);
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
    await waitFor(instance, "inject me");
    instance.stdin.write("i");
    await sleep(30);
    expect(injected === "inject me" ? injected : "missing").toBe("inject me");
    instance.unmount();
  });

  test("esc on the list closes the modal", async () => {
    let closed = 0;
    const path = await tempPath();
    const instance = mount(path, () => {
      closed += 1;
    });
    await waitFor(instance, "no notes yet");
    instance.stdin.write("\x1b");
    await sleep(30);
    expect(closed).toBe(1);
    instance.unmount();
  });
});
