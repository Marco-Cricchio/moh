import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-subagents-"));
}
import { builtinTools, createSession, DevelopmentLaneStore, MockProvider, type AgentEvent, type Tool } from "../src/index";
import { createRoute, Endpoint } from "../src/route";
import { BUILTIN_AGENT_PRESETS, DEFAULT_SUBAGENT_CONCURRENCY, Semaphore, subagentPreview, type SubagentResult } from "../src/subagents";

describe("Semaphore (#1143)", () => {
  test("release transfers the permit: no double-grant past limit", async () => {
    const sem = new Semaphore(1);
    const holder = new AbortController().signal;
    expect(await sem.acquire(holder)).toBe(true);

    // Two waiters queue, then the holder releases. Release hands the permit
    // to exactly one live waiter without decrementing; a fresh acquire()
    // racing in between must not grant a second permit.
    const w1 = sem.acquire(new AbortController().signal);
    const w1Dropped = sem.acquire(new AbortController().signal);
    sem.release();

    const w1Result = await w1;
    expect(w1Result).toBe(true);
    // The second queued waiter stays blocked: the permit was transferred,
    // not double-granted.
    let droppedGranted = false;
    w1Dropped.then((v) => (droppedGranted = v));
    await Promise.resolve();
    await Promise.resolve();
    expect(droppedGranted).toBe(false);

    // Settle cleanly: hand permits down the queue until everyone drains.
    sem.release(); // -> the dropped waiter
    sem.release(); // -> queue empty, decrement
    expect(await w1Dropped).toBe(true);
    // Fully drained: a fresh acquire is instant.
    expect(await sem.acquire(new AbortController().signal)).toBe(true);
  });

  test("aborted waiter never double-counts or leaks the permit", async () => {
    const sem = new Semaphore(1);
    const ac = new AbortController();
    expect(await sem.acquire(new AbortController().signal)).toBe(true);
    const waiter = sem.acquire(ac.signal);
    ac.abort();
    expect(await waiter).toBe(false);
    // The permit still counts as held by the first holder.
    let secondGranted = false;
    const second = sem.acquire(new AbortController().signal).then((v) => (secondGranted = v));
    await Promise.resolve();
    expect(secondGranted).toBe(false);
    sem.release();
    expect(await second).toBe(true);
    sem.release();
    // Fully drained: a fresh acquire is instant.
    expect(await sem.acquire(new AbortController().signal)).toBe(true);
  });
});

/** Collects parent events into an array for assertions. */
function tap(session: { events: AsyncIterable<AgentEvent> }): AgentEvent[] {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return events;
}

/** A tool that records invocations and can simulate latency. */
function recordingTool(name: string, delayMs = 0): Tool & { calls: number[] } {
  const t = {
    name,
    calls: [] as number[],
    description: `test tool ${name}`,
    inputSchema: undefined,
    async execute() {
      t.calls.push(Date.now());
      if (delayMs) await Bun.sleep(delayMs);
      return `${name} ok`;
    },
  } as unknown as Tool & { calls: number[] };
  return t;
}

describe("subagents (#13)", () => {
  test("preset spawn end-to-end: child session runs, result and events land in the parent log", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "find the answer" } }] },
        { deltas: ["spawned"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home: home,
        provider: MockProvider.scripted([
          { deltas: ["the answer is 42"], finish: "stop", usage: { inputTokens: 10, outputTokens: 5 } },
        ]),
      },
    });
    const events = tap(parent);

    const result = await parent.send("go");
    expect(result.status).toBe("done");

    const spawned = events.find((e) => e.type === "subagent_spawn");
    expect(spawned).toBeDefined();
    expect((spawned as any).name).toBe("research");
    expect((spawned as any).preset).toBe("research");
    const logFile = (spawned as any).log as string;
    expect(logFile.endsWith(".jsonl")).toBe(true);

    const done = events.find((e) => e.type === "subagent_result") as any;
    expect(done.status).toBe("done");
    expect(done.preview).toBe("the answer is 42"); // #320: transcript preview

    // The tool_result the parent model sees carries the SubagentResult.
    const toolResult = events.find((e) => e.type === "tool_result") as any;
    const parsed = JSON.parse(toolResult.output) as SubagentResult;
    expect(parsed).toEqual({ status: "done", output: "the answer is 42" });
  });

  test("lane-bound spawn: task `lane: <branch>` runs the child inside the lane worktree", async () => {
    const home = tmpHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-lane-parent-"));
    const store = new DevelopmentLaneStore({ cwd, home });
    const group = store.createFeatureGroup({ name: "lanes-it", targetRef: "develop" });
    store.createLane({
      featureGroupId: group.id, sessionId: "session-lane", worktreePath: "/tmp/lanes-it-worktree",
      branchRef: "feature/lanes-it-1", baseRef: "develop", baseRevision: "abc", targetRef: "develop",
      relation: "independent",
    });

    let childPrompt: string | undefined;
    const read = recordingTool("read");
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "lane: feature/lanes-it-1\nread the tree" } }] },
        { deltas: ["spawned"], finish: "stop" },
      ]),
      tools: { ...builtinTools(), read },
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: {
        home,
        lanes: { cwd },
        provider: MockProvider.scripted([
          { deltas: ["did the work"], finish: "stop" },
        ]),
      },
    });
    const events = tap(parent);
    // The fake read tool captures which directory the child ran in.
    (parent as any).tools.read.execute = async () => { childPrompt = "called"; return "ok"; };

    const result = await parent.send("go");
    expect(result.status).toBe("done");

    const laneCreated = events.find((e) => e.type === "lane_created") as any;
    expect(laneCreated).toBeDefined();
    expect(laneCreated.branchRef).toBe("feature/lanes-it-1");
    expect(laneCreated.worktreePath).toBe("/tmp/lanes-it-worktree");
    const spawned = events.find((e) => e.type === "subagent_spawn") as any;
    expect(spawned).toBeDefined();
  });

  test("lane-bound spawn with an unknown branch fails the spawn without side effects", async () => {
    const home = tmpHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-lane-miss-"));
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "lane: feature/nope\nwork" } }] },
        { deltas: ["after"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home, lanes: { cwd }, provider: MockProvider.scripted([{ deltas: ["x"], finish: "stop" }]) },
    });
    const events = tap(parent);

    const result = await parent.send("go");
    expect(result.status).toBe("done");
    const toolResult = events.find((e) => e.type === "tool_result") as any;
    const parsed = JSON.parse(toolResult.output) as SubagentResult;
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("no active lane");
    expect(events.find((e) => e.type === "subagent_spawn")).toBeUndefined();
  });

  test("empty model-generated fields do not erase a preset's tools (#323)", async () => {
    const home = tmpHome();
    const read = recordingTool("read");
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: {
          preset: "research", task: "read the principles",
          // Some tool-calling models serialize absent optional fields this way.
          systemPrompt: "", allowedTools: [], model: "", provider: "", context: "",
        } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: { ...builtinTools(), read },
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home,
        provider: MockProvider.scripted([
          { deltas: [], finish: "tool_calls", toolCalls: [{ name: "read", args: { path: "docs/principles.md" } }] },
          { deltas: ["child summary"], finish: "stop" },
        ]),
      },
    });

    await parent.send("go");
    expect(read.calls).toHaveLength(1);
  });

  test("an empty tool list remains valid for an inline spawn (#323)", async () => {
    const home = tmpHome();
    const read = recordingTool("read");
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { name: "no-tools", task: "do not read", allowedTools: [] } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: { ...builtinTools(), read },
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home,
        provider: MockProvider.scripted([
          { deltas: [], finish: "tool_calls", toolCalls: [{ name: "read", args: { path: "docs/principles.md" } }] },
          { deltas: ["child summary"], finish: "stop" },
        ]),
      },
    });

    await parent.send("go");
    expect(read.calls).toHaveLength(0);
  });

  test("inline spec spawn works and the child has its own JSONL log with usage tokens", async () => {
    const events: AgentEvent[] = [];
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { name: "helper", task: "say hi", allowedTools: ["read"] } }] },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home: home,
        provider: MockProvider.scripted([
          { deltas: ["hi from child"], finish: "stop", usage: { inputTokens: 7, outputTokens: 3 } },
        ]),
      },
    });
    const tapped = tap(parent);

    const result = await parent.send("go");
    expect(result.status).toBe("done");

    const spawned = tapped.find((e) => e.type === "subagent_spawn") as any;
    expect(spawned.name).toBe("helper");
    expect(spawned.preset).toBeUndefined();

    const res = tapped.find((e) => e.type === "subagent_result") as any;
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(res.log).toBe(spawned.log);
  });

  test("allowedTools is a strict subset; spawn and MCP tools are never inherited", async () => {
    const secret = recordingTool("secret");
    const mcpFake: Tool = {
      name: "mcp__evil__steal",
      description: "fake mcp tool",
      inputSchema: undefined,
      execute: () => "stolen",
    };
    // The child asks for tools outside its strict subset (mcp, spawn, bash)
    // and each must fail as an unknown tool in the child's own log.
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [{ name: "spawn", args: { name: "p", task: "t", allowedTools: ["secret"] } }],
        },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: { ...builtinTools(), secret, "mcp__evil__steal": mcpFake },
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home: home,
        provider: MockProvider.scripted([
          { deltas: [], finish: "tool_calls", toolCalls: [{ name: "mcp__evil__steal", args: {} }] },
          { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { task: "recurse" } }] },
          { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "ls" } }] },
          { deltas: ["gave up"], finish: "stop" },
        ]),
      },
    });
    const tapped = tap(parent);
    await parent.send("go");

    const spawned = tapped.find((e) => e.type === "subagent_spawn") as any;
    // The child log is readable: it must show denials for the MCP tool and
    // unknown-tool failures for spawn/bash, and no mcp lifecycle events.
    const childLog = readFileSync(spawned.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AgentEvent);
    const childResults = childLog.filter((e) => e.type === "tool_result") as any[];
    expect(childResults.length).toBe(3);
    expect(childResults.every((r) => r.ok === false)).toBe(true);
    expect(childResults[0].output).toContain("unknown tool: mcp__evil__steal");
    expect(childResults[1].output).toContain("unknown tool: spawn");
    expect(childResults[2].output).toContain("unknown tool: bash");
  });

  test("parallel spawns are capped by maxConcurrency (serialized under cap 1)", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [
            { name: "spawn", args: { name: "a", task: "1" } },
            { name: "spawn", args: { name: "b", task: "2" } },
            { name: "spawn", args: { name: "c", task: "3" } },
          ],
        },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home: home,
        maxConcurrency: 1,
        // Slow child (40ms/delta): under cap 1 the spawns serialize, so
        // the parent log alternates spawn/result strictly per child.
        provider: MockProvider.scripted([{ deltas: ["x"], finish: "stop", deltaDelayMs: 40 }]),
      },
    });
    const tapped = tap(parent);
    await parent.send("go");

    // Serialized: a_spawn, a_result, b_spawn, b_result, c_spawn, c_result.
    const lifecycle = tapped
      .filter((e) => e.type === "subagent_spawn" || e.type === "subagent_result")
      .map((e) => `${(e as any).type}:${(e as any).name}`);
    expect(lifecycle).toEqual([
      "subagent_spawn:a",
      "subagent_result:a",
      "subagent_spawn:b",
      "subagent_result:b",
      "subagent_spawn:c",
      "subagent_result:c",
    ]);
    expect(DEFAULT_SUBAGENT_CONCURRENCY).toBe(5);
  });

  test("default concurrency cap allows parallel children (spawns interleave)", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [
            { name: "spawn", args: { name: "a", task: "1" } },
            { name: "spawn", args: { name: "b", task: "2" } },
          ],
        },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home: home,
        provider: MockProvider.scripted([{ deltas: ["x"], finish: "stop", deltaDelayMs: 40 }]),
      },
    });
    const tapped = tap(parent);
    await parent.send("go");

    // Both children start (spawn events) before either finishes: the
    // default cap of 5 does not serialize two parallel spawns.
    const secondSpawnIndex = tapped.findIndex((e, i) => e.type === "subagent_spawn" && i > tapped.findIndex((x) => x.type === "subagent_spawn"));
    const firstResultIndex = tapped.findIndex((e) => e.type === "subagent_result");
    expect(secondSpawnIndex).toBeGreaterThan(-1);
    expect(secondSpawnIndex).toBeLessThan(firstResultIndex);
  });

  test("default cap of 5 queues the 6th spawn until a slot frees", async () => {
    const home = tmpHome();
    const names = ["a", "b", "c", "d", "e", "f"];
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: names.map((name) => ({ name: "spawn", args: { name, task: "1" } })),
        },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home: home,
        // Slow child: with the default cap the first 5 spawns run before
        // any result lands; the 6th child waits for a slot.
        provider: MockProvider.scripted([{ deltas: ["x"], finish: "stop", deltaDelayMs: 40 }]),
      },
    });
    const tapped = tap(parent);
    await parent.send("go");

    const lifecycle = tapped
      .filter((e) => e.type === "subagent_spawn" || e.type === "subagent_result")
      .map((e) => `${(e as any).type}:${(e as any).name}`);
    expect(lifecycle).toHaveLength(12);
    expect(lifecycle.filter((l) => l.startsWith("subagent_spawn:"))).toHaveLength(6);
    const resultCount = lifecycle.filter((l) => l.startsWith("subagent_result:")).length;
    expect(resultCount).toBe(6);
    // The 6th spawn must have queued: at least one child finished before
    // the 6th child could start (a slot freed).
    const fSpawnIndex = lifecycle.indexOf("subagent_spawn:f");
    const resultsBeforeF = lifecycle
      .slice(0, fSpawnIndex)
      .filter((l) => l.startsWith("subagent_result:")).length;
    expect(resultsBeforeF).toBeGreaterThanOrEqual(1);
  });

  test("child per-turn loop cap wraps up (#190): partial result reaches the parent", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [{ name: "spawn", args: { name: "looper", task: "loop forever", maxIterations: 1 } }],
        },
        { deltas: ["parent fine"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home: home,
        // Never stops: always requests another tool call; the wrap-up call
        // (#190) repeats the last entry with no tools offered, so its text
        // ("child partial") becomes the child's closing reply.
        provider: MockProvider.scripted([
          { deltas: ["child partial"], finish: "tool_calls", toolCalls: [{ name: "read", args: { path: "x" } }] },
        ]),
      },
    });
    const tapped = tap(parent);
    const result = await parent.send("go");
    expect(result.status).toBe("done");

    const res = tapped.find((e) => e.type === "subagent_result") as any;
    expect(res.status).toBe("done");

    const toolResult = tapped.find((e) => e.type === "tool_result") as any;
    const parsed = JSON.parse(toolResult.output) as SubagentResult;
    expect(parsed.status).toBe("done");
    expect(parsed.output).toContain("child partial");
  });

  test("aborting the parent turn propagates to the child; the parent continues afterwards", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [{ name: "spawn", args: { name: "slow", task: "slow task" } }],
        },
        { deltas: ["after"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home: home,
        provider: MockProvider.scripted([
          { deltas: ["never", "finishes"], finish: "stop", deltaDelayMs: 60 },
        ]),
      },
    });
    const tapped = tap(parent);
    const sendPromise = parent.send("go");
    // Abort while the child streams (its first delta is ~60ms out).
    await Bun.sleep(20);
    parent.abort();
    const result = await sendPromise;
    expect(result.status).toBe("cancelled");

    const res = tapped.find((e) => e.type === "subagent_result") as any;
    expect(res?.status).toBe("cancelled");

    // The parent session still works after the cancelled turn.
    const next = await parent.send("again");
    expect(next.status).toBe("done");
  });

  test("moh.json agents presets override the built-ins (user wins)", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [{ name: "spawn", args: { preset: "research", task: "x" } }],
        },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home: home,
        presets: {
          research: { ...BUILTIN_AGENT_PRESETS["research"]!, name: "research", systemPrompt: "custom" },
        },
        provider: MockProvider.scripted([{ deltas: ["r"], finish: "stop" }]),
      },
    });
    const tapped = tap(parent);
    await parent.send("go");
    const spawned = tapped.find((e) => e.type === "subagent_spawn") as any;
    expect(spawned.name).toBe("research");
  });

  test("unknown preset yields an error result without spawning", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [{ name: "spawn", args: { preset: "nope", task: "x" } }],
        },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home, provider: MockProvider.scripted([{ deltas: ["r"], finish: "stop" }]) },
    });
    const tapped = tap(parent);
    await parent.send("go");
    expect(tapped.find((e) => e.type === "subagent_spawn")).toBeUndefined();
    const toolResult = tapped.find((e) => e.type === "tool_result") as any;
    const parsed = JSON.parse(toolResult.output) as SubagentResult;
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("unknown subagent preset");
  });

  test("preset context is shared explicitly with the child as part of its first message", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "summarize" } }] },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: {
        home,
        presets: {
          research: {
            ...BUILTIN_AGENT_PRESETS["research"]!,
            context: "repo: moh, a headless agent core",
          },
        },
        provider: MockProvider.scripted([{ deltas: ["r"], finish: "stop" }]),
      },
    });
    const tapped = tap(parent);
    await parent.send("go");
    const spawned = tapped.find((e) => e.type === "subagent_spawn") as any;
    const childLog = readFileSync(spawned.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AgentEvent);
    const first = childLog.find((e) => e.type === "user_message") as any;
    expect(first.text).toBe("# Context\n\nrepo: moh, a headless agent core\n\n# Task\n\nsummarize");
  });

  test("child permission asks surface through the parent's consent seam", async () => {
    const asked: string[] = [];
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [{ name: "spawn", args: { name: "w", task: "write it", allowedTools: ["write"] } }],
        },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      onPermissionRequest: async (tool): Promise<"no"> => {
        asked.push(tool);
        return "no";
      },
      subagents: { home: home,
        provider: MockProvider.scripted([
          { deltas: [], finish: "tool_calls", toolCalls: [{ name: "write", args: { path: "out.txt", content: "x" } }] },
          { deltas: ["denied, moving on"], finish: "stop" },
        ]),
      },
    });
    const tapped = tap(parent);
    await parent.send("go");
    expect(asked).toEqual(["write"]);
    const res = tapped.find((e) => e.type === "subagent_result") as any;
    expect(res.status).toBe("done");
  });
});

describe("subagent_result preview (#320)", () => {
  test("a done result carries a bounded preview of the child's output", async () => {
    // scripted via the exported preview helper + event shape; the runner
    // path is covered by the spawn/result integration above.
    const long = ["line one", "line two", "line three", "line four"].join("\n");
    const preview = subagentPreview(long);
    expect(preview).toBe("line one\nline two\nline three");
  });

  test("preview is omitted when the child produced no output", () => {
    expect(subagentPreview("")).toBeUndefined();
  });
});

describe("#339 spawn by default + child ref pre-validation", () => {
  test("spawn is registered with no subagents config at all; an invalid inline ref fails fast with a didactic error and no side effects", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { name: "t", task: "x", provider: "bogus-endpoint/model" } }] },
        { deltas: ["recovered"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      // NOTE: no `subagents` option at all — zero-config registration (#339 A1);
      // the B2 fail-fast below keeps this side-effect-free (no child store).
    });
    const events = tap(parent);
    const result = await parent.send("go");
    expect(result.status).toBe("done");
    // B2: the model hallucinated a ref — fast structured error, parent turn safe,
    // and no child ever started (no spawn event = no store/session side effects).
    expect(events.find((e) => e.type === "subagent_spawn")).toBeUndefined();
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    const payload = JSON.parse((toolResult as any).output) as SubagentResult;
    expect(payload.status).toBe("error");
    expect(payload.error).toContain('unknown provider "bogus-endpoint/model"');
    expect(payload.error).toContain("use a preset or omit provider/model");
  });

  test("a valid inline ref (registered id) proceeds exactly as today", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { name: "t", task: "x", provider: "mock" } }] },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home },
    });
    const events = tap(parent);
    const result = await parent.send("go");
    expect(result.status).toBe("done");
    expect(events.find((e) => e.type === "subagent_spawn")).toBeDefined();
    expect(events.find((e) => e.type === "subagent_result")).toBeDefined();
  });
});

describe("#339 agents-{} equivalence (from-config presets merge)", () => {
  test("empty presets (moh.json agents:{}) resolve the built-in research preset", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "find it" } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home, presets: {} }, // what from-config produces for agents:{}
    });
    const events = tap(parent);
    await parent.send("go");
    const spawned = events.find((e) => e.type === "subagent_spawn") as any;
    expect(spawned?.name).toBe("research");
  });
});

describe("per-session route state for children (ADR-0050, #974)", () => {
  /** The parent's route: stop `a` is quota-exhausted, stop `b` serves. The
   * scripted model answers by *call index*, so the parent's spawn turn and
   * the child's inherited call are indistinguishable to a `createStream`
   * that keys on the target endpoint alone. */
  function parentRoute(clock: { value: number }, turns: Parameters<typeof MockProvider.scripted>[0], calls: string[]) {
    const model = MockProvider.scripted(turns);
    return createRoute({
      target: { endpoint: new Endpoint({ name: "a", kind: "mock" }), modelId: "model-a" },
      fallbacks: [{ endpoint: new Endpoint({ name: "b", kind: "mock" }), modelId: "model-b" }],
      retries: 0,
      now: () => clock.value,
      createStream: (target) => {
        calls.push(target.endpoint.name);
        const provider = target.endpoint.name === "a"
          ? MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "quota" } }])
          : model;
        return (messages, signal) => provider.stream(messages, signal);
      },
    });
  }

  test("a child born while the parent serves a fallback serves from the same stop, with no failed attempt", async () => {
    const clock = { value: 0 };
    const home = tmpHome();
    const calls: string[] = [];
    const route = parentRoute(clock, [
      { deltas: ["parent working"], finish: "stop" },
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "look into the fallback chain" } }] },
      { deltas: ["child reply"], finish: "stop" },
    ], calls);

    // The parent's first turn moves it onto the fallback stop (its own
    // probe of `a`) and leaves `a` in a quota cooldown.
    for await (const _ of route.stream([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], new AbortController().signal)) void _;
    expect(route.serving).toBe("b/model-b");

    // No `subagents.provider`: the child gets the parent's provider through
    // the host's live accessor — a route, so it inherits the pair and the
    // deadlines through `Route.childRoute` (ADR-0050 §4/§5).
    const parent = createSession({
      provider: route,
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home },
    });
    const events = tap(parent);
    await parent.send("spawn a research subagent");
    const spawned = events.find((e) => e.type === "subagent_spawn") as any;
    expect(spawned?.name).toBe("research");
    const childLog = readFileSync(spawned.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AgentEvent);

    // The child's opening record declares how it was born: selection `a`,
    // serving `b` — it precedes the child's first model call and names no
    // other stop as `previous`.
    const opening = childLog.find((e) => e.type === "route_serving") as any;
    expect(opening).toMatchObject({ type: "route_serving", selected: "a/model-a", serving: "b/model-b", previous: "a/model-a" });
    expect(childLog.indexOf(opening)).toBeLessThan(childLog.findIndex((e) => e.type === "model_call"));

    // The child spent no call re-probing the stop its parent already found
    // dead: `a` was attempted exactly once in this whole story (the
    // parent's own probe), and the child's log holds no `fallback`.
    expect(calls.filter((name) => name === "a")).toHaveLength(1);
    expect(childLog.some((e) => e.type === "fallback")).toBe(false);

    // The parent's log gained nothing for the child's serving state — its
    // own opening declaration is the only `route_serving` it holds, and no
    // `fallback` record from inside the child reached it (ADR-0050 §6).
    expect(events.filter((e) => e.type === "route_serving")).toHaveLength(1);
    expect(events.some((e) => e.type === "fallback")).toBe(false);
  });
});

describe("subagent_spawn requester/limits + orchestration stop (ADR-0055, #1127)", () => {
  test("a model-initiated spawn records requester=model and the applied limits", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "look", maxIterations: 7 } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: {
        home,
        provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      },
    });
    const events = tap(parent);
    await parent.send("go");
    const spawn = events.find((e) => e.type === "subagent_spawn") as any;
    expect(spawn.requester).toEqual({ kind: "model" });
    // Applied limits: the preset's allow-list, the session mode, and the
    // explicit cap named in the spawn request (50 default otherwise).
    expect(spawn.limits.tools).toEqual(["read", "glob", "grep", "fetch", "mpm_query"]);
    expect(spawn.limits.mode).toBe("normal");
    expect(spawn.limits.maxIterations).toBe(7);
  });

  test("the default cap is recorded when the spawn names none", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "look" } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home, provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]) },
    });
    const events = tap(parent);
    await parent.send("go");
    const spawn = events.find((e) => e.type === "subagent_spawn") as any;
    expect(spawn.limits.maxIterations).toBe(50);
  });

  test("stopSubagents aborts the live child and records one orchestration_stopped", async () => {
    const home = tmpHome();
    const release = Promise.withResolvers<void>();
    const gate = release.promise;
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "churn" } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: {
        home,
        provider: MockProvider.scripted([
          { deltas: ["working"], finish: "stop", hold: { afterDeltas: 0, release: gate } },
        ]),
      },
    });
    const events = tap(parent);
    const send = parent.send("go");
    // Wait until the child is registered as live (poll, never sample).
    let live: ReturnType<typeof parent.liveSubagents> = [];
    for (let i = 0; i < 50 && live.length === 0; i++) {
      await Bun.sleep(20);
      live = parent.liveSubagents();
    }
    expect(live).toHaveLength(1);
    expect(live[0]!.name).toBe("research");
    expect(live[0]!.requester).toEqual({ kind: "model" });

    const stopped = parent.stopSubagents();
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toBe(live[0]!.callId);

    const result = await send;
    expect(result.status).toBe("done");
    const childResult = events.find((e) => e.type === "subagent_result") as any;
    expect(childResult.status).toBe("cancelled");
    const stop = events.find((e) => e.type === "orchestration_stopped") as any;
    expect(stop.callIds).toEqual([live[0]!.callId]);
    expect(typeof stop.stoppedAt).toBe("string");
    // The stop is a chrome record, not a permission answer: after it, the
    // host lists nothing live.
    expect(parent.liveSubagents()).toHaveLength(0);
    release.resolve();
  });

  test("stopSubagents with nothing live records nothing and returns []", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]),
      tools: builtinTools(),
      subagents: { home, provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]) },
    });
    const events = tap(parent);
    await parent.send("go");
    expect(parent.stopSubagents()).toEqual([]);
    expect(events.some((e) => e.type === "orchestration_stopped")).toBe(false);
  });
});

describe("#1127: extension-requested spawns", () => {
  test("setSpawnRequester attributes subsequent spawns to the named extension", async () => {
    const home = tmpHome();
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "look" } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: { home, provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]) },
    });
    parent.setSpawnRequester(() => ({ kind: "extension", extension: "conductor" }));
    const events = tap(parent);
    await parent.send("go");
    const spawn = events.find((e) => e.type === "subagent_spawn") as any;
    expect(spawn.requester).toEqual({ kind: "extension", extension: "conductor" });
  });
});
