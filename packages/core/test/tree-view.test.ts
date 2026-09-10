/**
 * #580: `sessionTree(file)` → the client-facing TreeView projection
 * (ADR-0004 export): nodes in file order with depth, onActivePath, kind,
 * derived label and bookmark state, plus the head id. Consumed by the TUI
 * /tree panel and the CLI renderer; built and tested headless (spec §1).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { SessionStore, bookmarkNode, switchBranch, sessionTree, newSessionId, deleteSession } from "../src/session-store";
import { sessionTree as sessionTreeFromIndex } from "../src/index";
import type { AgentEvent } from "../src/types";
import type { TreeView } from "../src/session-store";

function tempStore(): { store: SessionStore; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), "moh-treeview-")), `${newSessionId()}.jsonl`);
  return { store: SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-"))), file };
}

function view(file: string): TreeView {
  const result = sessionTree(file);
  expect(result).toHaveProperty("nodes");
  return result as TreeView;
}

describe("sessionTree (#580)", () => {
  test("returns an error for a missing or corrupt file", () => {
    expect(sessionTree(join(tmpdir(), "moh-nope-", "missing.jsonl"))).toHaveProperty("error");
    const bad = join(mkdtempSync(join(tmpdir(), "moh-treeview-")), "bad.jsonl");
    writeFileSync(bad, "{not json\n");
    expect(sessionTree(bad)).toHaveProperty("error");
    const empty = join(mkdtempSync(join(tmpdir(), "moh-treeview-")), "empty.jsonl");
    writeFileSync(empty, "");
    expect(sessionTree(empty)).toHaveProperty("error");
  });

  test("is exported from the @moh/core index (same function)", () => {
    expect(sessionTreeFromIndex).toBe(sessionTree);
  });

  test("legacy linear log: all nodes line:N, single path, increasing depth", () => {
    const { file } = tempStore();
    // A pre-tree log: identity-less events, one JSON object per line.
    const lines = [
      JSON.stringify({ type: "session_start", schemaVersion: 2, promptVersion: "v" }),
      JSON.stringify({ type: "user_message", text: "fix the auth redirect loop please" }),
      JSON.stringify({ type: "assistant_delta", text: "ok" }),
      JSON.stringify({ type: "done" }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");
    const tv = view(file);
    // The turn node folds user+delta+tail: it re-anchors at "done" (line 4).
    expect(tv.nodes.map((n) => n.id)).toEqual(["line:1", "line:4"]);
    expect(tv.nodes.every((n) => n.onActivePath)).toBe(true);
    // Legacy events carry no parentId: the flat tree is all depth 0.
    expect(tv.nodes.map((n) => n.depth)).toEqual([0, 0]);
    expect(tv.headId).toBe("line:4");
    // Turn node: label derived from the first user message.
    expect(tv.nodes[1]!.kind).toBe("turn");
    expect(tv.nodes[1]!.label).toBe("fix the auth redirect loop please");
    // Non-turn events fold into the turn node (no per-delta nodes).
    expect(tv.nodes.map((n) => n.kind)).toEqual(["chrome", "turn"]);
    expect(tv.nodes[1]!.label).toBe("fix the auth redirect loop please");
  });

  test("tree log: one node per turn + chrome nodes, depth follows the branch", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    store.append({ type: "user_message", text: "first turn" });
    store.append({ type: "assistant_delta", text: "hi" });
    store.append({ type: "done" });
    store.append({ type: "user_message", text: "second turn" });
    const events = store.load();
    const firstUser = events[1]!.id!;
    const secondUser = events[4]!.id!;

    // Rewind: switch back to the first turn and branch.
    switchBranch(store.file, firstUser);
    store.append({ type: "user_message", text: "branch turn" });

    // The turn-1 node re-anchored at its "done" tail — that id is what the
    // head points at, so `firstUser` (the opener) is the node's opener, not
    // its id. Match by label/kind.
    const tv = view(store.file);
    const kinds = tv.nodes.map((n) => [n.kind, n.label, n.depth]);
    // session_start is chrome, depth 0.
    expect(kinds[0]).toEqual(["chrome", "session_start", 0]);
    expect(kinds[1]).toEqual(["turn", "first turn", 1]);
    // The abandoned second turn and the new branch are siblings at depth 2
    // (each chains to a depth-1 node: the turn-1 tail, the first turn).
    const secondNode = tv.nodes.find((n) => n.id === secondUser)!;
    const branchNode = tv.nodes.find((n) => n.label === "branch turn")!;
    expect(secondNode.depth).toBe(2);
    expect(branchNode.depth).toBe(2);
    expect(branchNode.label).toBe("branch turn");
    // Active path: session_start, first turn, branch turn — not the abandoned one.
    expect(secondNode.onActivePath).toBe(false);
    expect(tv.nodes.find((n) => n.label === "first turn")!.onActivePath).toBe(true);
    expect(branchNode.onActivePath).toBe(true);
    expect(tv.nodes[0]!.onActivePath).toBe(true);
    // Head: the switch's `to` is the first turn's opener — its node maps
    // to the first-turn row (re-anchored at its tail).
    const firstTurnNode = tv.nodes.find((n) => n.label === "first turn")!;
    expect(tv.headId).toBe(firstTurnNode.id);
  });

  test("bookmark state: last tree_bookmarked per node wins, clear removes", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    store.append({ type: "user_message", text: "target turn" });
    const target = store.load()[1]!.id!;

    let tv = view(store.file);
    expect(tv.nodes.find((n) => n.id === target)!.bookmark).toBeUndefined();

    bookmarkNode(store.file, target, "attempt-2");
    tv = view(store.file);
    expect(tv.nodes.find((n) => n.id === target)!.bookmark).toEqual({ name: "attempt-2" });

    bookmarkNode(store.file, target); // unnamed set (toggle)
    tv = view(store.file);
    expect(tv.nodes.find((n) => n.id === target)!.bookmark).toEqual({});

    bookmarkNode(store.file, target, ""); // clear
    tv = view(store.file);
    expect(tv.nodes.find((n) => n.id === target)!.bookmark).toBeUndefined();
  });

  test("line:N bookmark targets a legacy turn", () => {
    const { file } = tempStore();
    const lines = [
      JSON.stringify({ type: "session_start", schemaVersion: 2, promptVersion: "v" }),
      JSON.stringify({ type: "user_message", text: "legacy turn" }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    bookmarkNode(file, "line:2", "pre-tree");
    const tv = view(file);
    expect(tv.nodes[1]!.bookmark).toEqual({ name: "pre-tree" });
  });

  test("mid-turn references resolve to the owning row (head and bookmark)", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    store.append({ type: "user_message", text: "turn one" });
    store.append({ type: "assistant_delta", text: "hi" });
    const events = store.load();
    const delta = events[2]!.id!; // interior event, not a node

    // A bookmark on the interior delta lands on the turn's row.
    bookmarkNode(store.file, delta, "mid");
    let tv = view(store.file);
    const turnNode = tv.nodes.find((n) => n.label === "turn one")!;
    expect(turnNode.bookmark).toEqual({ name: "mid" });

    // A switch to the interior delta puts the head on that same row.
    switchBranch(store.file, delta);
    tv = view(store.file);
    expect(tv.headId).toBe(turnNode.id);
  });

  test("viewing a session does not register it as open (delete still works)", () => {
    const { store } = tempStore();
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    store.append({ type: "user_message", text: "soon deleted" });
    const file = store.file;
    store.dispose();
    view(file);
    // #478 open-registry refusal must not fire for a read-only view.
    expect(() => deleteSession(file, process.cwd())).not.toThrow();
  });
});
