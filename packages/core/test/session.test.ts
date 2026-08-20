import { describe, expect, test } from "bun:test";
import { builtinTools, createSession, MockProvider, PromptComposer, hashPrompt } from "../src/index";
import type { Message, Provider } from "../src/index";

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
      "session_mode",
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

    // The session survives: a subsequent send on the SAME session completes
    // a fresh turn and the log keeps growing.
    const result2 = await session.send("again");
    expect(result2.reason).toBe("max_iterations");
    expect(session.pending()).toBe(false);
    const errors = session.history().filter((e) => e.type === "error");
    expect(errors.length).toBe(2);
    expect(session.history()[0]!.type).toBe("session_start");
  });

  test("session_start carries promptVersion and the system prompt leads every model call", async () => {
    let seenMessages: Message[] = [];
    const capture: Provider = {
      name: "capture",
      async *stream(messages: Message[]) {
        seenMessages = messages.map((m) => ({ ...m }));
        yield { type: "finish", reason: "stop" };
      },
    };
    const composer = new PromptComposer({ projectDir: "/nonexistent-project" });
    const session = createSession({ provider: capture, promptComposer: composer });

    const start = session.history()[0] as any;
    expect(start.promptVersion).toMatch(/^[0-9a-f]{16}$/);

    await session.send("hello");
    expect(seenMessages[0]!.role).toBe("system");
    const system = (seenMessages[0]!.parts[0] as any).text as string;
    // Fixed section order in the assembled system prompt.
    const idx = (name: string) => system.indexOf(name);
    expect(idx("You are moh")).toBeLessThan(idx("## Environment"));
    expect(idx("## Environment")).toBeLessThan(idx("## Tools"));
    expect(system).toContain("## Environment");
    // promptVersion in the log is the hash of the assembled system prompt.
    expect(hashPrompt(system)).toBe(start.promptVersion);
  });

  test("event log is append-only, replayable, and session_start carries schemaVersion", async () => {
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]),
    });
    await session.send("replay me");

    const log = session.history();
    expect(log[0]!.type).toBe("session_start");
    expect((log[0] as any).schemaVersion).toBe(1);
    expect((log[0] as any).promptVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(log.map((e) => e.type)).toEqual([
      "session_start",
      "session_mode",
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

import { replayMessages } from "../src/session-store";
import type { Tool } from "../src/index";

describe("steering (mid-stream cancellation + re-send)", () => {
  test("send() during an active stream aborts the turn, logs cancelled, and restarts with the steering message", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["a", "b", "c", "d"], finish: "stop", deltaDelayMs: 30 },
      { deltas: ["steered reply"], finish: "stop" },
    ]);
    const session = createSession({ provider });

    const first = session.send("first");
    await Bun.sleep(45); // mid-stream on turn 1
    const steered = session.send("steer!");

    const [r1, r2] = await Promise.all([first, steered]);
    expect(r1.status).toBe("cancelled");
    expect(r2.status).toBe("done");
    expect(session.pending()).toBe(false);

    const types = session.history().map((e) => e.type);
    const cancelledAt = types.indexOf("cancelled");
    expect(cancelledAt).toBeGreaterThan(0);
    expect(types[cancelledAt + 1]).toBe("user_message");
    expect(types[types.length - 1]).toBe("done");
    const userTexts = session
      .history()
      .filter((e) => e.type === "user_message")
      .map((e: any) => e.text);
    expect(userTexts).toEqual(["first", "steer!"]);
  });

  test("steering propagates the abort signal into running tools", async () => {
    let observedSignal: AbortSignal | null = null;
    const slowTool: Tool = {
      name: "slow",
      description: "sleeps",
      inputSchema: undefined,
      async execute(_args: unknown, ctx) {
        observedSignal = ctx.signal;
        // Sleep in small slices so the tool reacts promptly to its AbortSignal.
        while (!ctx.signal.aborted) await Bun.sleep(10);
        return "aborted";
      },
    };
    const provider = MockProvider.scripted([
      { deltas: ["calling"], finish: "tool_calls", toolCalls: [{ name: "slow", args: {} }] },
      { deltas: ["after steering"], finish: "stop" },
    ]);
    const session = createSession({ provider, tools: { slow: slowTool }, permissions: { overrides: { tools: { slow: "allow" } } } });

    const first = session.send("go");
    await Bun.sleep(20); // inside the tool
    expect(session.pending()).toBe(true);
    const steered = session.send("steer");

    const [r1, r2] = await Promise.all([first, steered]);
    expect(r1.status).toBe("cancelled");
    expect(r2.status).toBe("done");
    expect(observedSignal).not.toBeNull();
    expect(observedSignal!.aborted).toBe(true);
  });

  test("event log of a steered turn replays into sane messages", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["partial ", "answer", "!"], finish: "stop", deltaDelayMs: 25 },
      { deltas: ["final"], finish: "stop" },
    ]);
    const session = createSession({ provider });
    const first = session.send("q1");
    await Bun.sleep(30);
    const steered = session.send("q2");
    await Promise.all([first, steered]);

    const messages = replayMessages(session.history());
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    const texts = messages.map((m) => (m.parts[0] as any).text);
    expect(texts[0]).toBe("q1");
    expect("partial answer!".startsWith(texts[1])).toBe(true); // aborted mid-stream prefix
    expect(texts.slice(2)).toEqual(["q2", "final"]);
  });

  test("steering during tool execution logs cancelled before the steering user_message", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["calling"], finish: "tool_calls", toolCalls: [{ name: "slow", args: {} }] },
      { deltas: ["restarted"], finish: "stop" },
    ]);
    const slowTool: Tool = {
      name: "slow",
      description: "sleeps",
      inputSchema: undefined,
      async execute(_args: unknown, ctx) {
        await Bun.sleep(200);
        return ctx.signal.aborted ? "aborted" : "done";
      },
    };
    const session = createSession({ provider, tools: { slow: slowTool }, permissions: { overrides: { tools: { slow: "allow" } } } });

    const first = session.send("go");
    await Bun.sleep(20); // inside tool
    const steered = session.send("steer");
    const [r1, r2] = await Promise.all([first, steered]);

    expect(r1.status).toBe("cancelled");
    expect(r2.status).toBe("done");
    const types = session.history().map((e) => e.type);
    expect(types.indexOf("cancelled")).toBeLessThan(types.lastIndexOf("user_message"));
    // The aborted tool_call may lack a tool_result; replay must not choke.
    const messages = replayMessages(session.history());
    expect(messages.every((m) => m.parts.length >= 1)).toBe(true);
  });
});

describe("resume (#31)", () => {
  test("a session resumed from history continues the log and conversation without re-appending session_start", async () => {
    const first = createSession({
      provider: MockProvider.scripted([{ deltas: ["first answer"], finish: "stop" }]),
    });
    await first.send("first question");
    const history = first.history();

    const seen: string[][] = [];
    const second = createSession({
      provider: MockProvider.scripted([{ deltas: ["second answer"], finish: "stop" }]),
      resume: { events: history },
      sink: (event) => seen.push([event.type]),
    });
    const result = await second.send("second question");

    expect(result.status).toBe("done");
    const log = second.history();
    expect(log[0].type).toBe("session_start"); // the seeded original, not a new one
    expect(log.slice(0, history.length)).toEqual(history);
    const newTexts = log.filter((e: any) => e.type === "user_message").map((e: any) => e.text);
    expect(newTexts).toEqual(["first question", "second question"]);
    // Only the new events reached the sink (the file already has the history).
    expect(seen.map(([t]) => t)).toEqual(["user_message", "assistant_delta", "done"]);
  });

  test("runtime permission rules are restored from the resumed history", async () => {
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const first = createSession({
      provider,
      tools: builtinTools(),
      permissions: { mode: "normal" },
      onPermissionRequest: () => "always",
    });
    await first.send("run it");
    const history = first.history();
    expect(history.some((e: any) => e.type === "permission_rule_added")).toBe(true);

    const second = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      resume: { events: history },
    });
    await second.send("run it again");
    const log = second.history();
    // No new permission events: the restored runtime rule allowed the call silently.
    const newPermissionEvents = log.slice(history.length).filter((e: any) => e.type.startsWith("permission_"));
    expect(newPermissionEvents).toEqual([]);
    const result = log.find((e: any) => e.type === "tool_result")!;
    expect((result as any).ok).toBe(true);
  });
});

describe("resume mode change (#31)", () => {
  test("a mode change across resume is logged as a new session_mode event", async () => {
    const first = createSession({
      provider: MockProvider.scripted([{ deltas: ["a"], finish: "stop" }]),
    });
    await first.send("q");
    const history = first.history();

    const sink: string[] = [];
    const second = createSession({
      provider: MockProvider.scripted([{ deltas: ["b"], finish: "stop" }]),
      resume: { events: history },
      permissions: { mode: "auto-accept" },
      sink: (event) => sink.push(event.type),
    });
    await second.send("q2");
    const modes = second.history().filter((e: any) => e.type === "session_mode") as any[];
    expect(modes.map((m) => m.mode)).toEqual(["normal", "auto-accept"]);
    expect(sink).toContain("session_mode");
  });
});
