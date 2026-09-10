/**
 * #577: the active-path projection — one pass turns a session file's
 * event array into the linear root→head path (following parentId chains
 * from the head, file order within the path). Orphans are off-path,
 * excluded — never silently merged.
 */
import { describe, expect, test } from "bun:test";
import { activePath } from "../src/session/event-log";
import { newUlid } from "../src/session/ulid";
import type { AgentEvent } from "../src/types";

function ev(type: string, id?: string, parentId?: string): AgentEvent {
  return {
    type,
    ...(id !== undefined ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
  } as AgentEvent;
}

describe("activePath (#577, core spec d1)", () => {
  test("a legacy identity-less log projects to itself (degenerate linear tree)", () => {
    const events = [ev("session_start"), ev("user_message"), ev("done")];
    expect(activePath(events)).toEqual(events);
  });

  test("a fully linear identified log projects to itself, file order", () => {
    const a = newUlid(), b = newUlid(), c = newUlid();
    const events = [ev("session_start", a), ev("user_message", b, a), ev("done", c, b)];
    expect(activePath(events)).toEqual(events);
  });

  test("an abandoned branch is off-path: the path follows parentId chains from the head", () => {
    // tree: a → b → c(head of first line) ; branch a → d → e
    const a = newUlid(), b = newUlid(), c = newUlid(), d = newUlid(), e = newUlid();
    const events = [
      ev("session_start", a),
      ev("user_message", b, a),
      ev("done", c, b),
      ev("user_message", d, a), // fork point child: off-path once head is e
      ev("assistant_delta", e, d),
    ];
    const path = activePath(events);
    expect(path.map((x) => x.id)).toEqual([a, d, e]);
  });

  test("a branch_switched head makes the path follow the switched `to`", () => {
    const a = newUlid(), b = newUlid(), c = newUlid(), s = newUlid();
    const events = [
      ev("session_start", a),
      ev("user_message", b, a),
      ev("assistant_delta", c, b),
      // switch back to the interior node b: appended on the tail but the
      // head is now b — the path is a → b only (c is off-path).
      { ...ev("branch_switched", s, c), to: b } as AgentEvent,
    ];
    const path = activePath(events);
    expect(path.map((x) => x.id)).toEqual([a, b]);
  });

  test("orphans (parentId not on the path) are excluded, never merged", () => {
    const a = newUlid(), b = newUlid();
    const ghost = newUlid();
    const events = [
      ev("session_start", a),
      ev("user_message", b, a),
      ev("done", newUlid(), ghost), // orphan: parent not in file
    ];
    expect(activePath(events).map((x) => x.id)).toEqual([a, b]);
  });

  test("a dangling head (from resolveHead's fallback) still yields a valid path", () => {
    const a = newUlid(), b = newUlid(), s = newUlid();
    const ghost = newUlid();
    const events = [
      ev("session_start", a),
      ev("user_message", b, a),
      // dangling switch: head falls back to b; the switch node itself
      // rides the old branch (parent = b's chain) so it stays on-path.
      { ...ev("branch_switched", s, b), to: ghost } as AgentEvent,
    ];
    const path = activePath(events);
    expect(path.map((x) => x.id)).toEqual([a, b, s]);
  });

  test("markers encountered along the path are collected (chrome stays in the path)", () => {
    const a = newUlid(), m = newUlid(), b = newUlid();
    const events = [
      ev("session_start", a),
      { type: "session_resumed", id: m, parentId: a } as AgentEvent,
      ev("done", b, m),
    ];
    const path = activePath(events);
    expect(path.some((e) => e.type === "session_resumed")).toBe(true);
  });

  test("an empty log projects to an empty path", () => {
    expect(activePath([])).toEqual([]);
  });
});

describe("activePath marker collection edge cases", () => {
  test("a switch onto an abandoned branch does not drag that branch's nodes in", () => {
    const a = newUlid(), b = newUlid(), d = newUlid(), e = newUlid(), s = newUlid();
    const events = [
      ev("session_start", a),
      ev("user_message", b, a),
      // abandoned branch: a → d → e
      ev("user_message", d, a),
      ev("assistant_delta", e, d),
      // head switch back to the linear tip b: marker on e's chain — e is
      // off-path, so the marker must NOT ride the path through e.
      { ...ev("branch_switched", s, e), to: b } as AgentEvent,
    ];
    expect(activePath(events).map((x) => x.id)).toEqual([a, b]);
  });

  test("a switch whose parent is on-path stays on the path", () => {
    const a = newUlid(), b = newUlid(), s = newUlid();
    const events = [
      ev("session_start", a),
      ev("user_message", b, a),
      { ...ev("branch_switched", s, b), to: a } as AgentEvent,
    ];
    // head = a: the path is exactly [a]. b is a side child of a (not on
    // the root→head chain) and s rides b's branch — both off-path.
    expect(activePath(events).map((x) => x.id)).toEqual([a]);
  });
});
