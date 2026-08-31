/**
 * ToolRunner (#91): same-turn tool execution — schema validation,
 * unknown-tool handling, gated execution, parallel run (completion-order
 * events) with sequential downgrade when the provider lacks
 * parallelToolCalls, and result parts for the feedback message.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRunner, type ToolRunnerOptions } from "../src/session/tool-runner";
import type { AgentEvent, Message, Tool, ToolCall } from "../src/types";

function makeTool(over: Partial<Tool> & { name: string }): Tool {
  return { description: "test tool", inputSchema: undefined, execute: () => "ok", ...over };
}

function harness(opts: {
  parallel?: boolean;
  tools?: Record<string, Tool>;
  gate?: ToolRunnerOptions["gate"];
  askUser?: boolean;
} = {}) {
  const events: AgentEvent[] = [];
  const tools = opts.tools ?? {};
  const runner = new ToolRunner({
    tools: () => tools,
    gate: opts.gate ?? { check: async () => ({ allowed: true }) },
    parallel: () => opts.parallel ?? true,
    cwd: "/w",
    skillDirs: () => ["/skills"],
    filesystemScope: () => "project",
    turn: () => 1,
    ...(opts.askUser ? { onAskUser: (async () => ({ kind: "answer", text: "y" })) as never } : {}),
    append: (e) => events.push(e),
  });
  return { runner, events, tools };
}

const call = (name: string, args: unknown = {}): ToolCall => ({ callId: `c-${name}`, name, args });

describe("ToolRunner", () => {
  test("emits tool_call for every call up front, tool_result in completion order when parallel", async () => {
    let resolveSlow!: () => void;
    const slow = makeTool({
      name: "slow",
      execute: () => new Promise<string>((r) => { resolveSlow = () => r("slow-done"); }),
    });
    const fast = makeTool({ name: "fast", execute: () => "fast-done" });
    const { runner, events } = harness({ tools: { slow, fast } });
    const signal = new AbortController().signal;
    const pending = runner.run([call("slow"), call("fast")], signal);
    await new Promise((r) => setTimeout(r, 1));
    resolveSlow();
    const { outcome, parts } = await pending;
    expect(outcome).toBe("ok");
    // tool_call events both up front, tool_result fast-then-slow (completion order).
    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_call", "tool_call", "tool_result", "tool_result"]);
    expect((events[2] as any).callId).toBe("c-fast");
    expect((events[3] as any).callId).toBe("c-slow");
    expect(parts).toEqual([
      { kind: "tool_result", callId: "c-fast", ok: true, output: "fast-done" },
      { kind: "tool_result", callId: "c-slow", ok: true, output: "slow-done" },
    ] satisfies Message["parts"]);
  });

  test("runs sequentially when parallel capability is false", async () => {
    const order: string[] = [];
    const inFlight = new Set<string>();
    const t = (name: string) =>
      makeTool({
        name,
        execute: async () => {
          inFlight.add(name);
          order.push(`start:${name}`);
          await new Promise((r) => setTimeout(r, 2));
          expect(inFlight.size).toBe(1);
          inFlight.delete(name);
          return `${name}-done`;
        },
      });
    const { runner } = harness({ parallel: false, tools: { a: t("a"), b: t("b") } });
    const { outcome, parts } = await runner.run([call("a"), call("b")], new AbortController().signal);
    expect(outcome).toBe("ok");
    expect(order).toEqual(["start:a", "start:b"]);
    expect(parts.map((p) => (p as any).callId)).toEqual(["c-a", "c-b"]);
  });

  test("unknown tool → failed result, never throws", async () => {
    const { runner, events } = harness();
    const { parts } = await runner.run([call("nope")], new AbortController().signal);
    expect(parts).toEqual([{ kind: "tool_result", callId: "c-nope", ok: false, output: "unknown tool: nope" }]);
    expect(events.at(-1)).toMatchObject({ type: "tool_result", ok: false });
  });

  test("invalid args fail with schema issues before the gate or execute", async () => {
    let gateChecked = false;
    let executed = false;
    const tool = makeTool({
      name: "typed",
      inputSchema: z.object({ n: z.number() }),
      execute: () => { executed = true; return "never"; },
    });
    const { runner } = harness({
      tools: { typed: tool },
      gate: { check: async () => { gateChecked = true; return { allowed: true }; } },
    });
    const { parts } = await runner.run([call("typed", { n: "x" })], new AbortController().signal);
    expect(parts[0]).toMatchObject({ ok: false });
    expect((parts[0] as any).output).toContain("invalid arguments for typed");
    expect(gateChecked).toBe(false);
    expect(executed).toBe(false);
  });

  test("gate denial becomes a failed result", async () => {
    const tool = makeTool({ name: "gated", execute: () => "never" });
    const { runner } = harness({
      tools: { gated: tool },
      gate: { check: async () => ({ allowed: false, denial: "permission denied: gated" }) },
    });
    const { parts } = await runner.run([call("gated")], new AbortController().signal);
    expect(parts).toEqual([{ kind: "tool_result", callId: "c-gated", ok: false, output: "permission denied: gated" }]);
  });

  test("execute throws → failed result with the error message", async () => {
    const tool = makeTool({ name: "boom", execute: () => { throw new Error("kaput"); } });
    const { runner } = harness({ tools: { boom: tool } });
    const { parts } = await runner.run([call("boom")], new AbortController().signal);
    expect(parts).toEqual([{ kind: "tool_result", callId: "c-boom", ok: false, output: "kaput" }]);
  });

  test("a tool that never settles is closed with a failed synthetic result on abort (#237)", async () => {
    const controller = new AbortController();
    const never = makeTool({
      name: "never",
      execute: () => new Promise<string>(() => {}), // hangs forever (orphaned children holding pipes)
    });
    const { runner, events } = harness({ tools: { never } });
    const pending = runner.run([call("never")], controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    // Must settle promptly (not wait for the hung tool) with a failed
    // tool_result for the open call, so the log and the in-memory message
    // list never carry an orphan tool_call.
    const { outcome, parts } = await pending;
    expect(outcome).toBe("aborted");
    expect(parts).toEqual([
      { kind: "tool_result", callId: "c-never", ok: false, output: "turn cancelled before the tool returned" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "tool_result", callId: "c-never", ok: false });
  });

  test("aborted signal → outcome 'aborted'", async () => {
    const controller = new AbortController();
    const tool = makeTool({
      name: "wait",
      execute: (_a, ctx) =>
        new Promise<string>((r) => {
          if (ctx.signal.aborted) return r("stopped");
          ctx.signal.addEventListener("abort", () => r("stopped"));
        }),
    });
    const { runner } = harness({ tools: { wait: tool } });
    const pending = runner.run([call("wait")], controller.signal);
    controller.abort();
    const { outcome } = await pending;
    expect(outcome).toBe("aborted");
  });

  test("empty call list is ok with no events", async () => {
    const { runner, events } = harness();
    const { outcome, parts } = await runner.run([], new AbortController().signal);
    expect(outcome).toBe("ok");
    expect(parts).toEqual([]);
    expect(events).toEqual([]);
  });

  test("ToolContext carries cwd, skillDirs and askUser when provided", async () => {
    const contexts: any[] = [];
    const tool = makeTool({ name: "ctx", execute: (_a, ctx) => { contexts.push(ctx); return "ok"; } });
    const { runner } = harness({ tools: { ctx: tool }, askUser: true });
    await runner.run([call("ctx")], new AbortController().signal);
    expect(contexts[0].cwd).toBe("/w");
    expect(contexts[0].skillDirs).toEqual(["/skills"]);
    expect(typeof contexts[0].askUser).toBe("function");
    expect(contexts[0].onProgress).toBeTypeOf("function");
    expect(contexts[0].turn).toBe(1);
    // Without onAskUser the channel is absent (headless fail-fast contract).
    const seen: any[] = [];
    const bareTool = makeTool({ name: "ctx", execute: (_a, ctx) => { seen.push(ctx); return "ok"; } });
    const bare = harness({ tools: { ctx: bareTool } });
    await bare.runner.run([call("ctx")], new AbortController().signal);
    expect(seen[0].askUser).toBeUndefined();
  });

  test("interactive tools serialize within a parallel batch; non-interactive keep concurrency (#223)", async () => {
    const active = new Set<string>();
    let peak = 0;
    const track = async (name: string, ms: number) => {
      active.add(name);
      peak = Math.max(peak, active.size);
      await new Promise((r) => setTimeout(r, ms));
      active.delete(name);
      return `${name}-done`;
    };
    const ask = (n: string) => makeTool({ name: n, interactive: true, execute: () => track(n, 5) });
    const work = makeTool({ name: "work", execute: () => track("work", 5) });
    const { runner } = harness({ tools: { q1: ask("q1"), q2: ask("q2"), work } });
    const { outcome, parts } = await runner.run([call("q1"), call("work"), call("q2")], new AbortController().signal);
    expect(outcome).toBe("ok");
    expect(parts.map((p) => (p as { callId: string }).callId)).toEqual(["c-work", "c-q1", "c-q2"]);
    // The two questions never overlapped; work overlapped at least one of them.
    expect(peak).toBeGreaterThan(1);
  });

  test("a single interactive call in a batch is untouched", async () => {
    const order: string[] = [];
    const q = makeTool({ name: "q", interactive: true, execute: async () => { order.push("q"); return "a"; } });
    const w = makeTool({ name: "w", execute: async () => { order.push("w"); return "b"; } });
    const { runner } = harness({ tools: { q, w } });
    await runner.run([call("q"), call("w")], new AbortController().signal);
    expect(order.length).toBe(2);
    expect(order).toContain("w");
    expect(order).toContain("q");
  });

  test("stamps the tool's effective timeoutMs on tool_call, absent when the tool has none (#300)", async () => {
    const timed = makeTool({ name: "timed", timeoutMs: () => 5_000, execute: () => "ok" });
    const untimed = makeTool({ name: "untimed", execute: () => "ok" });
    const { runner, events } = harness({ tools: { timed, untimed } });
    await runner.run([call("timed"), call("untimed")], new AbortController().signal);
    const first = events[0] as { type: string; timeoutMs?: number };
    const second = events[1] as { type: string; timeoutMs?: number };
    expect(first.type).toBe("tool_call");
    expect(first.timeoutMs).toBe(5_000);
    expect(second.type).toBe("tool_call");
    expect("timeoutMs" in second).toBe(false);
  });

  test("a resolver returning a non-finite value yields no timeoutMs — never trust the model's args (#300)", async () => {
    const weird = makeTool({ name: "weird", timeoutMs: () => Number.NaN, execute: () => "ok" });
    const { runner, events } = harness({ tools: { weird } });
    await runner.run([call("weird", { timeoutMs: "soon" })], new AbortController().signal);
    const event = events[0] as { timeoutMs?: number };
    expect("timeoutMs" in event).toBe(false);
  });
});
