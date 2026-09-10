/**
 * #578: compaction over the session tree — the marker carries `upToId`,
 * covers only the active root→head path, resolves on-path (last marker
 * on the path wins; sibling-branch markers invisible), lands on the
 * summarized branch (the turn's head, d7), and a dangling pointer
 * restarts context visibly (d6). Legacy numeric `upTo` reads as `line:N`.
 */
import { describe, expect, test } from "bun:test";
import { activePath, pathTo, resolveHead } from "../src/session/event-log";
import { compactionProjection, replayMessages, replayWarnings } from "../src/session-store";
import { newUlid } from "../src/session/ulid";
import type { AgentEvent, Message } from "../src/types";

function ev(type: string, id?: string, parentId?: string): AgentEvent {
  return {
    type,
    ...(id !== undefined ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
  } as AgentEvent;
}

function marker(summary: string, upToId: string, id?: string, parentId?: string): AgentEvent {
  return { type: "compaction", summary, upToId, ...(id !== undefined ? { id } : {}), ...(parentId !== undefined ? { parentId } : {}) } as AgentEvent;
}

const textParts = (m: Message): string =>
  m.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n");

describe("marker resolution on the tree (#578, spec d4/d5)", () => {
  test("last marker on the path wins; a sibling-branch marker is invisible", () => {
    const a = newUlid(), b = newUlid(), c = newUlid(), d = newUlid(), e = newUlid(), m1 = newUlid(), s = newUlid();
    const events: AgentEvent[] = [
      ev("session_start", a),
      ev("user_message", b, a),
      ev("done", c, b),
      // side branch with its own marker...
      ev("user_message", d, a),
      marker("summary of the side branch", d, m1, d),
      ev("assistant_delta", e, m1),
      // ...and a switch back to c: head = c, path = a → b → c. The side
      // branch (and its marker) never enters the projection, so replay
      // sees no compaction at all.
      { ...ev("branch_switched", s, c), to: c } as AgentEvent,
    ];
    const path = activePath(events);
    expect(path.map((x) => x.id)).toEqual([a, b, c]);
    expect(compactionProjection(path)).toBeUndefined();
    // Replay sees no compaction: the marker (and all chrome) is dropped,
    // the plain turn remains as context.
    expect(replayMessages(path)).toHaveLength(1);
  });

  test("switching back to a branch reactivates its marker", () => {
    const a = newUlid(), b = newUlid(), c = newUlid(), d = newUlid(), m = newUlid(), s = newUlid();
    const events: AgentEvent[] = [
      ev("session_start", a),
      ev("user_message", b, a),
      ev("done", c, b),
      // side branch holding a marker at its second node...
      ev("user_message", d, a),
      marker("branch summary", d, m, d),
      // ...and the head moves onto that branch: the marker is on the
      // active path again.
      { ...ev("branch_switched", s, c), to: m } as AgentEvent,
    ];
    const path = activePath(events);
    const projection = compactionProjection(path);
    expect(projection).toBeDefined();
    expect(projection!.summary).toBe("branch summary");
    // The covered prefix (before the marker, on-path) is replaced.
    expect(path[projection!.upToIndex]!.id).toBe(d);
  });

  test("upToId clamps at the marker's own position", () => {
    const a = newUlid(), b = newUlid(), m = newUlid(), c = newUlid();
    const events = [
      ev("session_start", a),
      ev("user_message", b, a),
      // corrupt/lying pointer: names an event appended after the marker
      marker("s", c, m, b),
      ev("done", c, m),
    ] as AgentEvent[];
    const projection = compactionProjection(events);
    expect(projection!.upToIndex).toBeLessThanOrEqual(events.indexOf(events[2]!));
  });

  test("dangling upToId: projection flags it and replay surfaces a visible warning (d6)", () => {
    const a = newUlid(), b = newUlid(), m = newUlid(), c = newUlid();
    const events = [
      ev("session_start", a),
      ev("user_message", b, a),
      marker("s", newUlid(), m, b), // pointer to an absent id
      ev("done", c, m),
    ] as AgentEvent[];
    expect(replayWarnings(events)).toHaveLength(1);
    const messages = replayMessages(events);
    // Context restarts from the path start (no summary substitution).
    expect(messages.some((msg) => textParts(msg).includes("warning"))).toBe(true);
    expect(messages.some((msg) => textParts(msg).includes("[Compaction summary]"))).toBe(false);
    expect(messages.some((msg) => textParts(msg).includes("user turn") || msg.role === "user")).toBe(true);
  });

  test("legacy numeric upTo reads positionally", () => {
    const events = [
      { type: "session_start", schemaVersion: 1, promptVersion: "p" },
      { type: "user_message", text: "t1" },
      { type: "user_message", text: "t2" },
      { type: "compaction", summary: "legacy", upTo: 2 },
      { type: "user_message", text: "t3" },
    ] as AgentEvent[];
    const projection = compactionProjection(events);
    expect(projection).toBeDefined();
    expect(projection!.upToIndex).toBe(2);
    expect(projection!.dangling).toBe(false);
    const messages = replayMessages(events);
    expect(textParts(messages[0]!)).toContain("legacy");
    expect(JSON.stringify(messages)).toContain("t3");
    expect(JSON.stringify(messages)).not.toContain("t1");
  });
});

describe("pathTo (#578, spec d7)", () => {
  test("projects onto an interior node of an abandoned branch", () => {
    const a = newUlid(), b = newUlid(), c = newUlid(), d = newUlid(), e = newUlid(), s = newUlid();
    const events = [
      ev("session_start", a),
      ev("user_message", b, a),
      ev("done", c, b),
      ev("user_message", d, a), // side branch: a → d → e
      ev("assistant_delta", e, d),
      // head back on the first line: a → b → c is active, a → d → e is not.
      { ...ev("branch_switched", s, c), to: c } as AgentEvent,
    ];
    expect(pathTo(events, e)?.map((x) => x.id)).toEqual([a, d, e]);
    expect(pathTo(events, b)?.map((x) => x.id)).toEqual([a, b]);
    expect(pathTo(events, newUlid())).toBeNull(); // unknown node
  });
});

describe("writer-side semantics", () => {
  test("resolveHead fallback keeps the marker pointer resolvable on a legacy prefix", () => {
    // Legacy events have no ids: a bridge `line:N` pointer resolves
    // positionally; `compactionProjection` honors both forms.
    const events = [
      { type: "session_start", schemaVersion: 1, promptVersion: "p" },
      { type: "user_message", text: "t1" },
      { type: "compaction", summary: "bridge", upToId: "line:2" },
      { type: "user_message", text: "t2" },
    ] as AgentEvent[];
    const projection = compactionProjection(events);
    expect(projection!.upToIndex).toBe(1);
  });
});
