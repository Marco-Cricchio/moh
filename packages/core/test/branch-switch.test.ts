/**
 * #576: the `branch_switched` writer seam and head resolution — the
 * in-file tree's head primitive (format decision 6, head semantics d1–d2,
 * d10).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { SessionStore, lineRef, resolveEventRef, switchBranch } from "../src/session-store";
import { resolveHead } from "../src/session/event-log";
import { newUlid } from "../src/session/ulid";
import type { AgentEvent } from "../src/types";

function tempStore(): { store: SessionStore; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), "moh-branch-")), "s.jsonl");
  return { store: SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-"))), file };
}

function buildLog(...events: Partial<AgentEvent>[]): AgentEvent[] {
  let prev: string | undefined;
  return events.map((e) => {
    const id = newUlid();
    const event = { ...e, id, ...(prev ? { parentId: prev } : {}) } as AgentEvent;
    prev = id;
    return event;
  });
}

describe("resolveHead (#576, head semantics d4)", () => {
  test("no branch_switched: head is the last event", () => {
    const log = buildLog({ type: "session_start", schemaVersion: 2, promptVersion: "v" }, { type: "user_message", text: "hi" });
    const { head, dangling } = resolveHead(log);
    expect(head).toBe(log[1]!.id);
    expect(dangling).toBeUndefined();
  });

  test("the last branch_switched wins: head is its `to`", () => {
    const log = buildLog(
      { type: "session_start", schemaVersion: 2, promptVersion: "v" },
      { type: "user_message", text: "a" },
      { type: "user_message", text: "b" },
    );
    const target = log[1]!.id!;
    log.push({ type: "branch_switched", to: target, id: newUlid(), parentId: log[2]!.id });
    log.push({ type: "assistant_delta", text: "x", id: newUlid(), parentId: log[3]!.id });
    const { head, dangling } = resolveHead(log);
    expect(head).toBe(target);
    expect(dangling).toBeUndefined();
  });

  test("an interior `to` still wins over later events on the abandoned branch", () => {
    const log = buildLog({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    const interior = log[0]!.id!;
    // Split: two events share the same parent (implicit branch).
    const a = { type: "user_message" as const, text: "a", id: newUlid(), parentId: interior };
    const b = { type: "user_message" as const, text: "b", id: newUlid(), parentId: interior };
    log.push(a, b, { type: "branch_switched", to: interior, id: newUlid(), parentId: b.id });
    const { head } = resolveHead(log);
    expect(head).toBe(interior);
  });

  test("a dangling `to` falls back to the last valid event and reports the warning", () => {
    const log = buildLog({ type: "session_start", schemaVersion: 2, promptVersion: "v" }, { type: "done" });
    log.push({ type: "branch_switched", to: newUlid(), id: newUlid(), parentId: log[1]!.id });
    const { head, dangling } = resolveHead(log);
    expect(head).toBe(log[1]!.id);
    expect(dangling).toBe(log[2] && (log[2] as { to: string }).to);
  });

  test("a purely legacy tail has no head", () => {
    const { head, dangling } = resolveHead([{ type: "session_start", schemaVersion: 1, promptVersion: "v" } as AgentEvent]);
    expect(head).toBeUndefined();
    expect(dangling).toBeUndefined();
  });
});

describe("switchBranch (#576, head semantics d2)", () => {
  test("appends one validated line immediately; last-wins; returns the switch id", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    const events = store.load();
    const target = events[0]!.id!;

    const switchId = switchBranch(store.file, target);
    expect(switchId).toBeDefined();

    const after = store.load();
    expect(after.length).toBe(2);
    const last = after[1] as { type: string; to: string; id?: string; parentId?: string };
    expect(last.type).toBe("branch_switched");
    expect(last.to).toBe(target);
    expect(last.id).toBe(switchId);
    // The switch event itself is a tree node (format decision 4).
    expect(last.parentId).toBe(events[0]!.id);
  });

  test("second switch overrides the first (last-wins) and head resolution follows", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    const first = store.load()[0]!.id!;
    switchBranch(store.file, first);
    switchBranch(store.file, first); // same target: still last-wins
    const { head } = resolveHead(store.load());
    expect(head).toBe(first);
  });

  test("refuses a target not present in the file (write-time validation)", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    expect(() => switchBranch(store.file, newUlid())).toThrow(/not found/);
    expect(store.load().length).toBe(1); // nothing appended
  });

  test("refuses a non-session or missing file", () => {
    const { store } = tempStore();
    expect(() => switchBranch(join(tmpdir(), "moh-missing.jsonl"), newUlid())).toThrow(/not found/);
    const notSession = join(mkdtempSync(join(tmpdir(), "moh-branch-")), "other.jsonl");
    writeFileSync(notSession, "");
    expect(() => switchBranch(notSession, newUlid())).toThrow(/not a session file/);
  });

  test("accepts a line:N bridge to a pre-tree event", () => {
    const { store } = tempStore();
    // Simulate a legacy (identity-less) first event followed by tree-era events.
    const raw = readFileSync(store.file, "utf8");
    const legacyLine = JSON.stringify({ type: "session_start", schemaVersion: 1, promptVersion: "v" }) + "\n";
    const stamped = { type: "user_message", text: "hi", id: newUlid() };
    store.append(stamped as AgentEvent);
    const current = readFileSync(store.file, "utf8");
    const tail = current.slice(raw.length);
    
    writeFileSync(store.file, legacyLine + tail);
    // The legacy event sits at line 1.
    const events = store.load();
    expect(events[0]!.id).toBeUndefined();
    expect(resolveEventRef(lineRef(1), events)).not.toBeNull();
    const switchId = switchBranch(store.file, lineRef(1));
    expect(switchId).toBeDefined();
    const { head, dangling } = resolveHead(store.load());
    expect(head).toBe(lineRef(1));
    expect(dangling).toBeUndefined();
  });

  test("no open session required: works on a closed file and disposes its probe", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    const file = store.file;
    store.dispose();
    // No throw, and the #478 open-session registry is clean afterwards.
    expect(switchBranch(file, store.load()[0]!.id!)).toBeDefined();
    const { deleteSession } = require("../src/session-store") as typeof import("../src/session-store");
    // If switchBranch leaked its probe into the registry, this delete would refuse.
    expect(() => deleteSession(file, process.cwd(), tmpdir())).not.toThrow();
  });
});
