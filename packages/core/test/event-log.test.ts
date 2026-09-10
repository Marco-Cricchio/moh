/**
 * EventLog (#89): the append-only session log — storage, sink fan-out,
 * listener notification (async iterator projection), and serial extension
 * dispatch with reentrancy guard. Seeded (resume) events are stored but
 * never re-appended: no sink, no listener, no dispatch.
 */
import { describe, expect, test } from "bun:test";
import { EventLog } from "../src/session/event-log";
import type { AgentEvent } from "../src/types";

function dispatcher(log: string[] = [], errors: AgentEvent[] = []) {
  return {
    dispatchEvent(event: AgentEvent): Promise<AgentEvent[]> {
      log.push(event.type);
      return Promise.resolve(errors);
    },
  };
}

describe("EventLog", () => {
  test("append reaches sink and history in order", async () => {
    const sunk: AgentEvent[] = [];
    const eventLog = new EventLog({ sink: (e) => sunk.push(e) });
    const a: AgentEvent = { type: "session_start", schemaVersion: 1, promptVersion: "v1" };
    const b: AgentEvent = { type: "session_mode", mode: "normal" };
    eventLog.append(a);
    eventLog.append(b);
    // #575: appended events gain writer-stamped identity — compare on
    // shape, not reference.
    expect(eventLog.history().map((e) => ({ ...e, id: undefined, parentId: undefined }))).toEqual([
      { ...a, id: undefined, parentId: undefined },
      { ...b, id: undefined, parentId: undefined },
    ]);
    expect(sunk.map((e) => ({ ...e, id: undefined, parentId: undefined }))).toEqual([
      { ...a, id: undefined, parentId: undefined },
      { ...b, id: undefined, parentId: undefined },
    ]);
    // New appends stream to an already-open iterator (listener path).
    const iter = eventLog.events[Symbol.asyncIterator]();
    expect((await iter.next()).value).toEqual(eventLog.history()[0]);
    await iter.return?.();
  });

  test("seeded (resume) events are stored but never re-appended", async () => {
    const sunk: AgentEvent[] = [];
    const dispatched: string[] = [];
    const seeded: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "v1" },
      { type: "user_message", text: "hi" },
    ];
    const eventLog = new EventLog({
      sink: (e) => sunk.push(e),
      extensions: dispatcher(dispatched),
    });
    eventLog.seed(seeded);
    expect(eventLog.history()).toEqual(seeded);
    expect(sunk).toEqual([]);
    await eventLog.idle();
    expect(dispatched).toEqual([]);
    // The live log array is the seeded one — appends continue after it.
    const next: AgentEvent = { type: "session_mode", mode: "normal" };
    eventLog.append(next);
    expect(eventLog.history()).toEqual([...seeded, eventLog.history().at(-1)!]);
    expect(eventLog.history().at(-1)!.id).toBeDefined();
    expect(sunk).toEqual([eventLog.history().at(-1)!]);
  });

  test("extension dispatch is serial and errors become extension_failed events", async () => {
    const order: string[] = [];
    const failure: AgentEvent = { type: "extension_failed", name: "x", reason: "hook", message: "boom" };
    let calls = 0;
    const eventLog = new EventLog({
      extensions: {
        dispatchEvent: (event) => {
          calls += 1;
          order.push(`dispatch:${event.type}`);
          return new Promise((resolve) =>
            setTimeout(() => resolve(calls === 1 ? [failure] : []), 1),
          );
        },
      },
    });
    eventLog.append({ type: "user_message", text: "one" });
    eventLog.append({ type: "user_message", text: "two" });
    await eventLog.idle();
    expect(order).toEqual(["dispatch:user_message", "dispatch:user_message"]);
    // The hook error was appended (sink + history) but not re-dispatched.
    expect({ ...eventLog.history().at(-1)!, id: undefined, parentId: undefined }).toEqual({ ...failure, id: undefined, parentId: undefined });
    expect(order.filter((t) => t === "dispatch:extension_failed")).toHaveLength(0);
  });

  test("events async iterator replays history then streams new appends", async () => {
    const eventLog = new EventLog();
    const first: AgentEvent = { type: "session_mode", mode: "normal" };
    eventLog.append(first);
    const iter = eventLog.events[Symbol.asyncIterator]();
    expect((await iter.next()).value).toEqual(eventLog.history()[0]);
    const second: AgentEvent = { type: "cancelled" };
    const pendingNext = iter.next();
    eventLog.append(second);
    expect((await pendingNext).value).toEqual(eventLog.history().at(-1));
    await iter.return?.();
  });

  test("idle resolves immediately with no extensions", async () => {
    const eventLog = new EventLog();
    eventLog.append({ type: "session_mode", mode: "normal" });
    await eventLog.idle();
  });
});

describe("EventLog identity (#575)", () => {
  test("every appended event carries a fresh ULID id", () => {
    const eventLog = new EventLog();
    const a: AgentEvent = { type: "session_start", schemaVersion: 2, promptVersion: "v" };
    const b: AgentEvent = { type: "session_mode", mode: "normal" };
    eventLog.append(a);
    eventLog.append(b);
    const [ha, hb] = eventLog.history();
    expect(ha.id).toMatch(/^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/);
    expect(hb.id).toMatch(/^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/);
    expect(hb.id).not.toBe(ha.id);
  });

  test("parentId defaults to the previous event's id (linear head)", () => {
    const eventLog = new EventLog();
    eventLog.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    eventLog.append({ type: "session_mode", mode: "normal" });
    const [a, b] = eventLog.history();
    expect(b.parentId).toBe(a.id);
  });

  test("an explicit parentId is preserved (off-head appends)", () => {
    const eventLog = new EventLog();
    eventLog.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    eventLog.append({ type: "session_mode", mode: "normal", parentId: "line:5" });
    const [, b] = eventLog.history();
    expect(b.parentId).toBe("line:5");
  });

  test("a purely legacy tail leaves parentId absent", () => {
    const seeded: AgentEvent[] = [{ type: "session_start", schemaVersion: 1, promptVersion: "v" }];
    const eventLog = new EventLog();
    eventLog.seed(seeded);
    eventLog.append({ type: "session_mode", mode: "normal" });
    const [, next] = eventLog.history();
    expect(next.parentId).toBeUndefined();
    expect(next.id).toBeDefined();
  });

  test("sink and listeners see the stamped event, not the bare input", () => {
    const sunk: AgentEvent[] = [];
    const eventLog = new EventLog({ sink: (e) => sunk.push(e) });
    const bare: AgentEvent = { type: "session_mode", mode: "normal" };
    eventLog.append(bare);
    const [stamped] = eventLog.history();
    expect(sunk[0]).toBe(stamped);
    expect(stamped.id).toBeDefined();
    expect(bare.id).toBeUndefined();
  });
});
