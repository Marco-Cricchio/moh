import { describe, expect, test } from "bun:test";
import {
  CONTEXT_WINDOW_DEFAULT,
  projectSidebar,
} from "../src/sidebar";

const ev = (e: Record<string, unknown>) => e as never;

describe("projectSidebar (issue #118)", () => {
  test("pairs tool calls with results and tracks subagent state", () => {
    const events = [
      ev({ type: "user_message", text: "hi" }),
      ev({ type: "tool_call", callId: "1", name: "bash", args: { command: "bun test" } }),
      ev({ type: "subagent_spawn", callId: "2", name: "research", log: "/tmp/x.jsonl" }),
      ev({ type: "tool_result", callId: "1", ok: true, output: "ok" }),
      ev({ type: "model_call", model: "m", usage: { inputTokens: 1000, outputTokens: 200 } }),
      ev({ type: "subagent_result", callId: "2", name: "research", status: "done", usage: { inputTokens: 5, outputTokens: 5 }, log: "/tmp/x.jsonl" }),
    ];
    const s = projectSidebar(events);
    expect(s.activity).toEqual([
      { kind: "tool", name: "bash", detail: "bun test", ok: true },
      { kind: "subagent", name: "research", status: "done" },
    ]);
  });

  test("an in-flight tool call stays ok: null and a spawned subagent stays running", () => {
    const events = [
      ev({ type: "tool_call", callId: "1", name: "read", args: { path: "/a/b.ts" } }),
      ev({ type: "subagent_spawn", callId: "2", name: "tdd", log: "/tmp/y.jsonl" }),
    ];
    const s = projectSidebar(events);
    expect(s.activity).toEqual([
      { kind: "tool", name: "read", detail: "/a/b.ts", ok: null },
      { kind: "subagent", name: "tdd", status: "running" },
    ]);
  });

  test("tokens: context = last model_call input, out = cumulative output", () => {
    const events = [
      ev({ type: "model_call", model: "m", usage: { inputTokens: 100, outputTokens: 50 } }),
      ev({ type: "model_call", model: "m", usage: { inputTokens: 900, outputTokens: 50 } }),
    ];
    expect(projectSidebar(events).tokens).toEqual({ contextIn: 900, totalOut: 100, calls: 2 });  });

  test("turnCount counts user messages (Workflow refresh trigger)", () => {
    const events = [ev({ type: "user_message", text: "a" }), ev({ type: "user_message", text: "b" })];
    expect(projectSidebar(events).turnCount).toBe(2);
  });

  test("empty log: zeroed tokens, empty activity", () => {
    expect(projectSidebar([])).toEqual({
      activity: [],
      tokens: { contextIn: 0, totalOut: 0, calls: 0 },
      turnCount: 0,
    });
  });
});


test("CONTEXT_WINDOW_DEFAULT is a sane modern window", () => {
  expect(CONTEXT_WINDOW_DEFAULT).toBeGreaterThan(100_000);
});
