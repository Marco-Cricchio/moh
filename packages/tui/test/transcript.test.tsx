import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { AgentEvent } from "@moh/core";
import { blockTint, projectTranscript, TranscriptBlockView } from "../src/transcript";
import { ThemeProvider, THEMES } from "../src/themes";
import { stripAnsi } from "./helpers";

const base: AgentEvent[] = [
  { type: "session_start", schemaVersion: 1, promptVersion: "abcdef123456" },
  { type: "session_mode", mode: "normal" },
  { type: "user_message", text: "hello" },
  { type: "assistant_delta", text: "prose\n```diff\n-old\n+new\n```" },
  { type: "tool_call", callId: "c1", name: "bash", args: { command: "bun test" } },
  { type: "permission_requested", callId: "c1", tool: "bash" },
  { type: "permission_granted", callId: "c1", tool: "bash", reason: "user" },
  { type: "tool_result", callId: "c1", ok: true, output: "1 pass ✓" },
  { type: "model_call", model: "mock", usage: { inputTokens: 100, outputTokens: 20 } },
  { type: "done", usage: { inputTokens: 100, outputTokens: 20 }, models: ["mock"] },
  { type: "model_switched", from: "mock", to: "next" },
  { type: "memory_updated", entries: 1, topics: ["testing"] },
  { type: "subagent_spawn", callId: "s1", name: "worker", log: "/tmp/log" },
  { type: "subagent_result", callId: "s1", name: "worker", status: "done", usage: { inputTokens: 3, outputTokens: 4 }, log: "/tmp/log" },
  { type: "mcp_server_started", server: "github", tools: ["issue"] },
  { type: "extension_failed", name: "broken", reason: "load", message: "boom" },
  { type: "cancelled" },
];

describe("semantic transcript projection (#183)", () => {
  test("covers productive, permission, usage, subagent and chrome events", () => {
    const blocks = projectTranscript(base);
    expect(blocks.some((block) => block.glyph === "›" && block.type === "you")).toBe(true);
    expect(blocks.some((block) => block.glyph === "◆" && block.type === "moh")).toBe(true);
    expect(blocks.some((block) => block.kind === "diff" && block.lines.includes("-old"))).toBe(true);
    expect(blocks.some((block) => block.type === "bash" && block.state === "ok" && block.lines[0] === "1 pass ✓")).toBe(true);
    expect(blocks.some((block) => block.type === "permission" && block.state === "ok")).toBe(true);
    expect(blocks.some((block) => block.type === "usage" && block.usage?.inputTokens === 100)).toBe(true);
    expect(blocks.some((block) => block.type === "model switched")).toBe(true);
    expect(blocks.some((block) => block.type === "memory updated")).toBe(true);
    expect(blocks.some((block) => block.type === "worker" && block.detail?.startsWith("done"))).toBe(true);
    expect(blocks.some((block) => block.type === "MCP started")).toBe(true);
    expect(blocks.some((block) => block.kind === "error" && block.type === "extension failed")).toBe(true);
    expect(blocks.some((block) => block.type === "cancelled")).toBe(true);
  });

  test("read output is rendered once as a numbered preview and obeys preview policy", () => {
    const events: AgentEvent[] = [
      { type: "tool_call", callId: "read-1", name: "read", args: { path: "a.ts" } },
      { type: "tool_result", callId: "read-1", ok: true, output: "one\ntwo" },
    ];
    const shown = projectTranscript(events, { filePreview: "on-demand" });
    expect(shown.find((block) => block.type === "read")?.lines).toEqual([]);
    expect(shown.filter((block) => block.type === "preview")).toHaveLength(1);
    expect(shown.find((block) => block.type === "preview")?.lines).toEqual(["  1 │ one", "  2 │ two"]);
    expect(projectTranscript(events, { filePreview: "none" }).some((block) => block.type === "preview")).toBe(false);
    const offset = projectTranscript([
      { type: "tool_call", callId: "read-2", name: "read", args: { path: "a.ts", offset: 8 } },
      { type: "tool_result", callId: "read-2", ok: true, output: "eight\nnine" },
    ], { filePreview: "always" }).find((block) => block.type === "preview")!;
    expect(offset.detail).toContain("8–9");
    expect(offset.lines[0]).toBe("  8 │ eight");
  });

  test("ask-user preserves question/answer semantic styling", () => {
    const block = projectTranscript([
      { type: "tool_call", callId: "ask-1", name: "ask_user", args: { question: "Choose?" } },
      { type: "tool_result", callId: "ask-1", ok: true, output: "first" },
    ])[0]!;
    expect(block.lines).toEqual(["Choose?", "↳ you: first"]);
    expect(block.lineKinds).toEqual(["ask", "answer"]);
  });

  test("never drops done or non-preview tool output", () => {
    expect(projectTranscript([{ type: "done" }])[0]?.type).toBe("done");
    const tool = projectTranscript([
      { type: "tool_call", callId: "bash-1", name: "bash", args: { command: "echo ok" } },
      { type: "tool_result", callId: "bash-1", ok: true, output: "ok" },
    ], { filePreview: "none" })[0]!;
    expect(tool.lines).toEqual(["ok"]);
  });

  test("groups consecutive assistant deltas into one prose block", () => {
    const blocks = projectTranscript([
      { type: "assistant_delta", text: "one " },
      { type: "assistant_delta", text: "two" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lines).toEqual(["one two"]);
  });

  test("interprets markdown headings and bullets within prose blocks", () => {
    const block = projectTranscript([{ type: "assistant_delta", text: "## Result\n- first" }])[0]!;
    expect(block.lines).toEqual(["Result", "· first"]);
    expect(block.lineKinds).toEqual(["heading", "bullet"]);
  });

  test("renders the validated head/body/gap grammar with tint and no transcript frame", () => {
    const block = projectTranscript([{ type: "user_message", text: "select this cleanly" }])[0]!;
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><TranscriptBlockView block={block} width={80} /></ThemeProvider>);
    const raw = ink.lastFrame() ?? "";
    const clean = stripAnsi(raw);
    expect(clean).toContain("› you");
    expect(clean).toContain("  select this cleanly");
    expect(clean).not.toMatch(/[┌┐└┘╭╮╰╯]/);
    expect(blockTint(block, THEMES["tokyo-night"])).not.toBe(THEMES["tokyo-night"].bg);
    expect(blockTint({ key: "cot", kind: "thinking", glyph: "⋯", type: "thinking", lines: ["inner"] }, THEMES["tokyo-night"])).toBeUndefined();
    ink.unmount();
  });
});
