import { describe, expect, test } from "bun:test";
import {
  UPDATE_POLL_INTERVAL_MS,
  skillUpdateNoticeText,
  statusRowUpdateText,
  startUpdatePoll,
} from "../src/update-poll";

/** #348: a 30-minute background poll for binary + skill updates, with an
 * anti-overlap guard, and the status-row-2 projection combining both
 * notices. Injectable timers: the scheduler is observable without fake
 * clock magic. */

describe("UPDATE_POLL_INTERVAL_MS", () => {
  test("thirty minutes", () => {
    expect(UPDATE_POLL_INTERVAL_MS).toBe(30 * 60_000);
  });
});

describe("skillUpdateNoticeText", () => {
  test("singular and plural include the actionable route", () => {
    expect(skillUpdateNoticeText(1)).toBe("1 skill update available (/skills update)");
    expect(skillUpdateNoticeText(3)).toBe("3 skill updates available (/skills update)");
  });
});

describe("statusRowUpdateText", () => {
  test("nothing discovered → no row-2 notice", () => {
    expect(statusRowUpdateText(null, null)).toBeUndefined();
    expect(statusRowUpdateText(null, 0)).toBeUndefined();
    expect(statusRowUpdateText("", 0)).toBeUndefined();
  });

  test("binary only, skill only", () => {
    expect(statusRowUpdateText("moh 0.8.0 available (moh update)", null)).toBe("moh 0.8.0 available (moh update)");
    expect(statusRowUpdateText(null, 2)).toBe("2 skill updates available (/skills update)");
  });

  test("both discovered coexist, binary first", () => {
    expect(statusRowUpdateText("moh 0.8.0 available (moh update)", 2))
      .toBe("moh 0.8.0 available (moh update) · 2 skill updates available (/skills update)");
  });
});

describe("startUpdatePoll", () => {
  interface Timer { fn: () => void; ms: number; id: number }
  function harness() {
    const timers = new Map<number, Timer>();
    let seq = 0;
    const set = (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { id, fn, ms });
      return id;
    };
    const clear = (id: unknown) => void timers.delete(id as number);
    const tick = () => { for (const t of [...timers.values()]) t.fn(); };
    const advanceFirstDue = () => {
      const first = [...timers.values()].sort((a, b) => a.ms - b.ms)[0];
      if (!first) throw new Error("no timer scheduled");
      first.fn();
    };
    return { set, clear, tick, advanceFirstDue, pending: () => timers.size };
  }

  test("fires on each interval tick", async () => {
    const h = harness();
    let fires = 0;
    const stop = startUpdatePoll({ fire: () => { fires++; }, intervalMs: 1000, timers: { set: h.set, clear: h.clear } });
    expect(fires).toBe(0); // no fire at start: the caller owns the launch check
    h.advanceFirstDue();
    expect(fires).toBe(1);
    h.advanceFirstDue();
    expect(fires).toBe(2);
    stop();
    expect(h.pending()).toBe(0);
  });

  test("skips a tick while the previous one is still in flight", async () => {
    const h = harness();
    let release: () => void = () => {};
    let fires = 0;
    const gate = new Promise<void>((r) => { release = r; });
    const stop = startUpdatePoll({
      fire: async () => { fires++; await gate; },
      intervalMs: 1000,
      timers: { set: h.set, clear: h.clear },
    });
    h.advanceFirstDue(); // in flight, never settles
    h.advanceFirstDue(); // overlapping tick: skipped
    h.advanceFirstDue(); // still skipped
    expect(fires).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 0)); // let the in-flight settle
    h.advanceFirstDue();
    expect(fires).toBe(2);
    stop();
  });

  test("a throwing fire never kills the scheduler", async () => {
    const h = harness();
    let fires = 0;
    const stop = startUpdatePoll({
      fire: () => { fires++; if (fires === 1) throw new Error("network exploded"); },
      intervalMs: 1000,
      timers: { set: h.set, clear: h.clear },
    });
    h.advanceFirstDue();
    h.advanceFirstDue();
    expect(fires).toBe(2);
    stop();
  });
});
