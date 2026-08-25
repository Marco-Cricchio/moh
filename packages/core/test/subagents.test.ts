import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-subagents-"));
}
import { builtinTools, createSession, MockProvider, type AgentEvent, type Tool } from "../src/index";
import { BUILTIN_AGENT_PRESETS, DEFAULT_SUBAGENT_CONCURRENCY, type SubagentResult } from "../src/subagents";

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

    // The tool_result the parent model sees carries the SubagentResult.
    const toolResult = events.find((e) => e.type === "tool_result") as any;
    const parsed = JSON.parse(toolResult.output) as SubagentResult;
    expect(parsed).toEqual({ status: "done", output: "the answer is 42" });
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
    expect(DEFAULT_SUBAGENT_CONCURRENCY).toBe(3);
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
    // default cap of 3 does not serialize two parallel spawns.
    const secondSpawnIndex = tapped.findIndex((e, i) => e.type === "subagent_spawn" && i > tapped.findIndex((x) => x.type === "subagent_spawn"));
    const firstResultIndex = tapped.findIndex((e) => e.type === "subagent_result");
    expect(secondSpawnIndex).toBeGreaterThan(-1);
    expect(secondSpawnIndex).toBeLessThan(firstResultIndex);
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
