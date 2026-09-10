/**
 * #579: the `tree_bookmarked` chrome event — set/rename/clear a node
 * bookmark, last-wins, `line:N` targets, never provider context (spec §4).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { SessionStore, lineRef, resolveEventRef, switchBranch, bookmarkNode } from "../src/session-store";
import { MockProvider, createSession } from "../src/index";
import { newUlid } from "../src/session/ulid";
import { replayMessages } from "../src/session-store";
import type { AgentEvent } from "../src/types";

function tempStore(): { store: SessionStore; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), "moh-bookmark-")), "s.jsonl");
  return { store: SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-"))), file };
}

function bookmarksOf(events: AgentEvent[]): { to: string; name?: string }[] {
  return events
    .filter((e): e is AgentEvent & { type: "tree_bookmarked"; to: string; name?: string } => e.type === "tree_bookmarked")
    .map((e) => ({ to: e.to, ...(e.name !== undefined ? { name: e.name } : {}) }));
}

/** Last bookmark state per node (the reader-side last-wins projection). */
function lastWins(events: AgentEvent[]): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  for (const b of bookmarksOf(events)) map.set(b.to, b.name);
  return map;
}

describe("bookmarkNode file-based writer (#579)", () => {
  test("appends a validated tree_bookmarked line; returns its id", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    const target = store.load()[0]!.id!;

    const id = bookmarkNode(store.file, target, "attempt-2");
    expect(id).toBeDefined();

    const after = store.load();
    expect(after.length).toBe(2);
    const last = after[1] as { type: string; to: string; name?: string; id?: string; parentId?: string };
    expect(last.type).toBe("tree_bookmarked");
    expect(last.to).toBe(target);
    expect(last.name).toBe("attempt-2");
    expect(last.id).toBe(id);
    // The bookmark event is itself a tree node (format d4) — counted for topology.
    expect(last.parentId).toBe(target);
  });

  test("set, rename and clear: last-wins, empty name resets (append-only)", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    const target = store.load()[0]!.id!;

    bookmarkNode(store.file, target); // set (unnamed)
    bookmarkNode(store.file, target, "attempt-2"); // rename
    bookmarkNode(store.file, target, "  "); // clear — whitespace trims to reset
    const events = store.load();

    // Nothing was deleted: the log keeps every event, append-only.
    expect(events.length).toBe(4);
    expect(bookmarksOf(events).map((b) => b.name)).toEqual([undefined, "attempt-2", ""]);
    expect(lastWins(events).get(target)).toBe(""); // cleared: the empty name IS the state

    // A new set after the clear wins again.
    bookmarkNode(store.file, target, "v3");
    expect(lastWins(store.load()).get(target)).toBe("v3");
  });

  test("two nodes bookmark independently (last-wins is per-node)", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    store.append({ type: "user_message", text: "hi" });
    const [a, b] = store.load().map((e) => e.id!);

    bookmarkNode(store.file, a, "root");
    bookmarkNode(store.file, b);
    const state = lastWins(store.load());
    expect(state.get(a)).toBe("root");
    expect(state.get(b)).toBeUndefined(); // unnamed bookmark: no name field
  });

  test("accepts a line:N bridge to a pre-tree (legacy) event", () => {
    const { store } = tempStore();
    // Simulate a legacy (identity-less) first event followed by tree-era events.
    const raw = readFileSync(store.file, "utf8");
    const legacyLine = JSON.stringify({ type: "session_start", schemaVersion: 1, promptVersion: "v" }) + "\n";
    store.append({ type: "user_message", text: "hi" } as AgentEvent);
    const current = readFileSync(store.file, "utf8");
    writeFileSync(store.file, legacyLine + current.slice(raw.length));

    const events = store.load();
    expect(events[0]!.id).toBeUndefined();
    expect(resolveEventRef(lineRef(1), events)).not.toBeNull();

    const id = bookmarkNode(store.file, lineRef(1), "legacy turn");
    expect(id).toBeDefined();
    const last = store.load().at(-1) as { type: string; to: string; name?: string };
    expect(last.type).toBe("tree_bookmarked");
    expect(last.to).toBe(lineRef(1));
    expect(last.name).toBe("legacy turn");
  });

  test("refuses a target not present in the file (write-time validation)", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    expect(() => bookmarkNode(store.file, newUlid())).toThrow(/not found/);
    expect(store.load().length).toBe(1); // nothing appended
  });

  test("refuses a missing or non-session file", () => {
    expect(() => bookmarkNode(join(tmpdir(), "moh-missing.jsonl"), newUlid())).toThrow(/not found/);
    const notSession = join(mkdtempSync(join(tmpdir(), "moh-bookmark-")), "other.jsonl");
    writeFileSync(notSession, "");
    expect(() => bookmarkNode(notSession, newUlid())).toThrow(/not a session file/);
  });
});

describe("session.bookmarkNode live writer (#579)", () => {
  function openSession(): { session: ReturnType<typeof createSession>; store: SessionStore } {
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")));
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["x"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    return { session, store };
  }

  test("appends through the live sink; last-wins; clears with an empty name", () => {
    const { session, store } = openSession();
    const target = store.load()[0]!.id!;

    expect(session.bookmarkNode(target, "pin")).toEqual({ ok: true });
    expect(session.bookmarkNode(target, "pin2")).toEqual({ ok: true });
    expect(session.bookmarkNode(target, "")).toEqual({ ok: true });
    const events = store.load();
    expect(bookmarksOf(events).map((b) => b.name)).toEqual(["pin", "pin2", ""]);
    expect(lastWins(events).get(target)).toBe(""); // cleared
    session.dispose();
  });

  test("accepts a line:N bridge target (legacy logs, live path)", () => {
    const { session, store } = openSession();
    // Prepend a legacy (identity-less) first line: the live log then holds
    // it at line 1 and the tree-era events after it.
    const raw = readFileSync(store.file, "utf8");
    const legacyLine = JSON.stringify({ type: "session_start", schemaVersion: 1, promptVersion: "v" }) + "\n";
    writeFileSync(store.file, legacyLine + raw);
    expect(session.bookmarkNode(lineRef(1), "legacy")).toEqual({ ok: true });
    const last = store.load().at(-1) as { type: string; to: string; name?: string };
    expect(last.type).toBe("tree_bookmarked");
    expect(last.to).toBe(lineRef(1));
    expect(last.name).toBe("legacy");
    session.dispose();
  });

  test("refuses an unresolved target and a disposed session", () => {
    const { session, store } = openSession();
    expect(session.bookmarkNode(newUlid())).toEqual({
      ok: false,
      error: expect.stringContaining("not found"),
    });
    expect(store.load().some((e) => e.type === "tree_bookmarked")).toBe(false);
    session.dispose();
    expect(session.bookmarkNode(store.load()[0]!.id!)).toEqual({ ok: false, error: "session is disposed" });
  });

  test("a bookmark after switchBranch rides the new branch with an explicit parent", () => {
    const { session, store } = openSession();
    const first = store.load()[0]!.id!;
    expect(session.switchBranch(first)).toEqual({ ok: true });
    expect(session.bookmarkNode(first, "rewind")).toEqual({ ok: true });
    const last = store.load().at(-1) as { type: string; to: string; parentId?: string };
    expect(last.type).toBe("tree_bookmarked");
    expect(last.to).toBe(first);
    // The bookmark anchors to the resolved head — `first`, the switch's
    // target — not to the switch line itself (the writer anchors to the
    // head, not the previous append).
    expect(last.parentId).toBe(first);
    session.dispose();
  });
});

describe("chrome discipline (#579)", () => {
  test("tree_bookmarked never enters provider context", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    const target = store.load()[0]!.id!;
    bookmarkNode(store.file, target, "attempt-2");

    const messages = replayMessages(store.load());
    const text = JSON.stringify(messages);
    expect(text).not.toContain("tree_bookmarked");
    expect(text).not.toContain("attempt-2");
  });

  test("a bookmark survives a replay reload (resume carries it for free)", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    const target = store.load()[0]!.id!;
    bookmarkNode(store.file, target, "attempt-2");
    store.dispose();

    const reopened = SessionStore.open(store.file);
    expect(lastWins(reopened.load()).get(target)).toBe("attempt-2");
    reopened.dispose();
  });
});
