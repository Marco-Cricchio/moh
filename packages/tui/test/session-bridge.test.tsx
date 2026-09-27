import { describe, expect, test } from "bun:test";
import React, { useEffect } from "react";
import { render } from "ink-testing-library";
import type { AgentEvent, AgentSession } from "@moh/core";
import { useSessionState, useSidebarState } from "../src/session-bridge";
import { waitForCondition } from "./helpers";

/**
 * Regression harness for #1031: the session-bridge hooks used to snapshot
 * `session.history()` once per replayed event per subscriber, and never
 * returned the events iterator on unmount (so the subscription — and its
 * per-event copying — outlived the component).
 */

/** A flush window plus slack; must comfortably exceed the source's FLUSH_MS (33). */
const FLUSH_MARGIN_MS = 120;

function userMessage(i: number): AgentEvent {
  return { type: "user_message", text: `m${i}` } as AgentEvent;
}

/** Minimal stand-in with EventLog's replay-then-stream `events` semantics. */
function fakeSession(seed: AgentEvent[]): {
  session: AgentSession;
  append: (event: AgentEvent) => void;
  subscriberCount: () => number;
} {
  const log = [...seed];
  const listeners = new Set<() => void>();
  const session = {
    history: () => [...log],
    get events() {
      let cursor = 0;
      let notify: (() => void) | null = null;
      const listener = () => notify?.();
      listeners.add(listener);
      let done = false;
      const iterator = {
        async next(): Promise<IteratorResult<AgentEvent>> {
          if (cursor < log.length) return { value: log[cursor++]!, done: false };
          if (done) return { value: undefined as never, done: true };
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
          if (cursor < log.length) return { value: log[cursor++]!, done: false };
          return { value: undefined as never, done: true };
        },
        async return(): Promise<IteratorResult<AgentEvent>> {
          listeners.delete(listener);
          done = true;
          return { value: undefined as never, done: true };
        },
      };
      return { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<AgentEvent>;
    },
  } as unknown as AgentSession;
  return {
    session,
    append(event: AgentEvent) {
      log.push(event);
      for (const listener of listeners) listener();
    },
    subscriberCount: () => listeners.size,
  };
}

let historyCalls = 0;
/** Wrap a session's `history()` so every snapshot is counted. */
function countHistoryCalls(session: AgentSession): AgentSession {
  const original = session.history.bind(session);
  (session as { history: () => AgentEvent[] }).history = () => {
    historyCalls += 1;
    return original();
  };
  return session;
}

/** Mounts both hooks over a session and mirrors the projected events out. */
function renderProbe(session: AgentSession): { instance: ReturnType<typeof render>; events: () => AgentEvent[] } {
  let events: AgentEvent[] = [];
  function Probe() {
    const state = useSessionState(session);
    useSidebarState(session);
    useEffect(() => {
      events = state.events;
    });
    return null;
  }
  const instance = render(<Probe />);
  return { instance, events: () => events };
}

describe("session-bridge snapshot discipline (#1031)", () => {
  test("a synchronous burst of 300 appends costs at most one snapshot per subscriber", async () => {
    const fake = fakeSession([userMessage(0)]);
    const session = countHistoryCalls(fake.session);
    const { instance, events } = renderProbe(session);
    await waitForCondition(() => events().length >= 1, () => "initial projection");

    const before = historyCalls;
    for (let i = 1; i <= 300; i += 1) fake.append(userMessage(i));
    await waitForCondition(() => events().length === 301, () => `burst projected (got ${events().length})`);

    // Two mounted subscribers, one flush each (~33ms window).
    expect(historyCalls - before).toBeLessThanOrEqual(2);

    // The projected event list is a full, monotonic snapshot of the log.
    const log = events();
    expect(log).toHaveLength(301);
    expect(log).toEqual(Array.from({ length: 301 }, (_, i) => userMessage(i)));

    instance.unmount();
  });

  test("opening a log of length L does not grow snapshot calls with L", async () => {
    for (const size of [100, 2_000]) {
      const big = Array.from({ length: size }, (_, i) => userMessage(i));
      const fake = fakeSession(big);
      const session = countHistoryCalls(fake.session);
      historyCalls = 0;
      const { instance, events } = renderProbe(session);
      await waitForCondition(() => events().length === size, () => `replay projected (L=${size})`);

      // initial() + effect-time snapshot, once per subscriber: 2 x 2.
      expect(historyCalls).toBeLessThanOrEqual(8);
      expect(events()).toEqual(big);
      instance.unmount();
    }
  });

  test("unmount detaches the subscription: zero snapshots, subscriber count back to baseline", async () => {
    const fake = fakeSession([userMessage(0)]);
    const session = countHistoryCalls(fake.session);
    const { instance, events } = renderProbe(session);
    await waitForCondition(() => events().length >= 1, () => "initial projection");
    expect(fake.subscriberCount()).toBe(2);

    instance.unmount();
    await waitForCondition(() => fake.subscriberCount() === 0, () => "listeners removed");

    const before = historyCalls;
    for (let i = 1; i <= 300; i += 1) fake.append(userMessage(i));
    await Bun.sleep(FLUSH_MARGIN_MS);

    expect(historyCalls - before).toBe(0);
  });

  test("session switch: the old session stops being snapshot and the projection follows the new log", async () => {
    const first = fakeSession([userMessage(1)]);
    const second = fakeSession([userMessage(2), userMessage(3)]);
    countHistoryCalls(first.session);
    countHistoryCalls(second.session);

    let active = first.session;
    let events: AgentEvent[] = [];
    function Probe() {
      const state = useSessionState(active);
      useSidebarState(active);
      useEffect(() => {
        events = state.events;
      });
      return null;
    }
    const instance = render(<Probe />);
    await waitForCondition(() => events.length === 1, () => "first session projected");

    const before = historyCalls;
    active = second.session;
    instance.rerender(<Probe />);
    await waitForCondition(() => events.length === 2, () => "second session projected");

    expect(events.map((e) => (e as unknown as { text: string }).text)).toEqual(["m2", "m3"]);

    // Let the second session's replay flush settle before the quiet phase.
    await Bun.sleep(FLUSH_MARGIN_MS);

    // Appends on the abandoned session must cost nothing.
    const quietBefore = historyCalls;
    first.append(userMessage(99));
    await Bun.sleep(FLUSH_MARGIN_MS);
    expect(historyCalls - quietBefore).toBe(0);
    expect(historyCalls - before).toBeLessThanOrEqual(8);
    expect(first.subscriberCount()).toBe(0);

    instance.unmount();
  });

  test("switching to a null session drops the old projection and detaches", async () => {
    const fake = fakeSession([userMessage(1)]);
    countHistoryCalls(fake.session);

    let active: AgentSession | null = fake.session;
    let events: AgentEvent[] = [];
    let sidebar: { activity: unknown[]; tokens: { calls: number }; turnCount: number } | null = null;
    function Probe() {
      const state = useSessionState(active!);
      const bar = useSidebarState(active);
      useEffect(() => {
        events = state.events;
        sidebar = bar;
      });
      return null;
    }
    const instance = render(<Probe />);
    await waitForCondition(() => events.length === 1, () => "live session projected");

    active = null;
    instance.rerender(<Probe />);
    await Bun.sleep(FLUSH_MARGIN_MS);

    expect(sidebar!.activity).toEqual([]);
    expect(sidebar!.tokens.calls).toBe(0);
    expect(sidebar!.turnCount).toBe(0);
    expect(fake.subscriberCount()).toBe(0);

    const before = historyCalls;
    fake.append(userMessage(2));
    await Bun.sleep(FLUSH_MARGIN_MS);
    expect(historyCalls - before).toBe(0);

    instance.unmount();
  });
});
