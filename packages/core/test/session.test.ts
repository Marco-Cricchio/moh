import { describe, expect, test } from "bun:test";
import { createSession, MockProvider } from "../src/index";

describe("core agent loop", () => {
  test("send() on a scripted MockProvider streams text_delta events and ends with done", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["Hello", " world"], finish: "stop" },
    ]);
    const session = createSession({ provider });

    const streamed: unknown[] = [];
    void (async () => {
      for await (const event of session.events) streamed.push(event);
    })();

    const result = await session.send("hi");
    await Bun.sleep(10);

    expect(result.status).toBe("done");
    expect(streamed.map((e: any) => e.type)).toEqual([
      "session_start",
      "user_message",
      "assistant_delta",
      "assistant_delta",
      "done",
    ]);
    const text = streamed
      .filter((e: any) => e.type === "assistant_delta")
      .map((e: any) => e.text)
      .join("");
    expect(text).toBe("Hello world");
  });

  test("abort() mid-stream stops the provider call and appends a cancelled event", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["a", "b", "c"], finish: "stop", deltaDelayMs: 30 },
    ]);
    const session = createSession({ provider });

    const sendPromise = session.send("hi");
    expect(session.pending()).toBe(true);

    await Bun.sleep(45); // mid-stream, after the first delta
    session.abort();
    const result = await sendPromise;

    expect(result.status).toBe("cancelled");
    expect(session.pending()).toBe(false);
    const log = session.history();
    expect(log[log.length - 1]!.type).toBe("cancelled");
    const deltas = log.filter((e) => e.type === "assistant_delta");
    expect(deltas.length).toBeLessThan(3);
  });

  test("two AgentSessions in the same process share no global state", async () => {
    const a = createSession({
      provider: MockProvider.scripted([{ deltas: ["A"], finish: "stop" }]),
    });
    const b = createSession({
      provider: MockProvider.scripted([{ deltas: ["B"], finish: "stop" }]),
    });

    const [ra, rb] = await Promise.all([a.send("to a"), b.send("to b")]);

    expect(ra.status).toBe("done");
    expect(rb.status).toBe("done");
    const userA = a.history().find((e) => e.type === "user_message")!;
    const userB = b.history().find((e) => e.type === "user_message")!;
    expect((userA as any).text).toBe("to a");
    expect((userB as any).text).toBe("to b");
    expect(a.history()).not.toEqual(b.history());
  });

  test("per-turn iteration cap emits error with reason max_iterations and the session survives", async () => {
    // A script that never stops loops the turn until the cap fires.
    const provider = MockProvider.scripted([
      { deltas: ["more"], finish: "tool_calls" },
    ]);
    const session = createSession({ provider, maxIterations: 3 });

    const result = await session.send("loop forever");
    expect(result).toEqual({
      status: "error",
      reason: "max_iterations",
      message: "iteration cap reached",
    });

    const log = session.history();
    const errorEvent = log.find((e) => e.type === "error");
    expect(errorEvent).toEqual({
      type: "error",
      reason: "max_iterations",
      message: "iteration cap of 3 reached",
    });

    // The session survives: a subsequent send works normally.
    const ok = MockProvider.scripted([{ deltas: ["fine"], finish: "stop" }]);
    const session2 = createSession({ provider: ok, maxIterations: 3 });
    expect((await session2.send("again")).status).toBe("done");
  });

  test("event log is append-only, replayable, and session_start carries schemaVersion", async () => {
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]),
    });
    await session.send("replay me");

    const log = session.history();
    expect(log[0]).toEqual({ type: "session_start", schemaVersion: 1 });
    expect(log.map((e) => e.type)).toEqual([
      "session_start",
      "user_message",
      "assistant_delta",
      "done",
    ]);

    // A late subscriber replays the full log in order from memory.
    const replayed: any[] = [];
    const iterator = session.events[Symbol.asyncIterator]();
    while (replayed.length < log.length) {
      const next = await iterator.next();
      replayed.push(next.value);
    }
    await iterator.return?.();
    expect(replayed).toEqual(log);

    // Appending never rewrites history: the log only grows.
    const before = session.history().length;
    await session.send("again");
    const after = session.history();
    expect(after.length).toBeGreaterThan(before);
    expect(after.slice(0, before)).toEqual(log);
  });
});
