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
  test("vibe hides metric/chrome blocks and keeps failures; dev keeps the full grammar (#193)", () => {
    const vibe = projectTranscript(base, { mode: "vibe" });
    expect(vibe.some((block) => block.type === "usage" || block.usage)).toBe(false);
    expect(vibe.some((block) => block.type === "done")).toBe(false);
    expect(vibe.some((block) => block.type === "session started" || block.type === "permission mode" || block.type === "model switched" || block.type === "memory updated" || block.type === "MCP started")).toBe(false);
    expect(vibe.some((block) => block.kind === "error" && block.type === "extension failed")).toBe(true);
    expect(vibe.some((block) => block.type === "cancelled")).toBe(true);
    expect(projectTranscript(base, { mode: "dev" }).some((block) => block.type === "usage" && block.usage?.inputTokens === 100)).toBe(true);
  });

  test("vibe renders tool activity as plain language without command or output (#193)", () => {
    const events: AgentEvent[] = [
      { type: "tool_call", callId: "v1", name: "bash", args: { command: "rm -rf secrets" } },
      { type: "tool_result", callId: "v1", ok: true, output: "1 pass" },
      { type: "tool_call", callId: "v2", name: "read", args: { path: "src/a.ts" } },
      { type: "tool_result", callId: "v2", ok: true, output: "one\ntwo" },
      { type: "tool_call", callId: "v3", name: "grep", args: { pattern: "vibe", path: "src" } },
      { type: "tool_call", callId: "v4", name: "ask_user", args: { question: "Proceed?" } },
      { type: "tool_result", callId: "v4", ok: true, output: "yes" },
    ];
    const blocks = projectTranscript(events, { mode: "vibe" });
    const plain = blocks.filter((block) => block.lines.length === 1);
    expect(plain.map((block) => block.lines[0])).toContain("ran a command");
    expect(plain.map((block) => block.lines[0])).toContain("read a file · src/a.ts");
    expect(plain.map((block) => block.lines[0])).toContain("searched the code · vibe");
    expect(blocks.some((block) => block.type === "preview")).toBe(false);
    expect(blocks.some((block) => block.lines.includes("1 pass") || block.lines.includes("  1 │ one"))).toBe(false);
    expect(blocks.find((block) => block.type === "ask")?.lines).toEqual(["Proceed?", "↳ you: yes"]);
    // The in-flight marker survives the plain-language collapse.
    expect(plain.find((block) => block.lines[0] === "searched the code · vibe")?.state).toBe("run");
    // dev keeps the technical detail
    const dev = projectTranscript(events, { mode: "dev" });
    expect(dev.find((block) => block.type === "bash")?.detail).toBe("rm -rf secrets");
    expect(dev.find((block) => block.type === "bash")?.lines).toEqual(["1 pass"]);
    expect(dev.some((block) => block.type === "preview")).toBe(true);
  });

  test("vibe shows a failed tool as an error with its message (#193)", () => {
    const blocks = projectTranscript([
      { type: "tool_call", callId: "f1", name: "bash", args: { command: "bun test" } },
      { type: "tool_result", callId: "f1", ok: false, output: "error: boom" },
    ], { mode: "vibe" });
    const failed = blocks.find((block) => block.state === "fail")!;
    expect(failed.kind).toBe("error");
    expect(failed.type).toBe("bash");
    expect(failed.detail).toBe("bun test");
    expect(failed.lines).toEqual(["error: boom"]);
  });



  test("covers productive, permission, usage, subagent and chrome events", () => {
    const blocks = projectTranscript(base);
    expect(blocks.some((block) => block.glyph === "›" && block.type === "you")).toBe(true);
    expect(blocks.some((block) => block.glyph === "◆" && block.type === "moh")).toBe(true);
    // Fenced diffs render inline through the Markdown renderer (#205), not
    // as a separate `diff` block.
    expect(blocks.some((block) => block.markdown?.includes("```diff") && block.markdown.includes("-old"))).toBe(true);
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

  test("renders assistant prose through the terminal Markdown renderer", () => {
    const block = projectTranscript([{ type: "assistant_delta", text: "## Result with **bold** and `code`" }])[0]!;
    expect(block.markdown).toBe("## Result with **bold** and `code`");
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><TranscriptBlockView block={block} width={80} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("Result");
    expect(frame).toContain("bold");
    ink.unmount();
  });

  test("splits a reply into append-only paragraph segments with stable keys; continuation segments render without a head row (#205)", () => {
    const events: AgentEvent[] = [{ type: "assistant_delta", text: "first paragraph.\n\nsecond paragraph with a list:\n\n- one\n\n- two\n\nfinal unclosed tail" }];
    const blocks = projectTranscript(events);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[0]!.continuation).toBeFalsy();
    expect(blocks.slice(1).every((block) => block.continuation === true)).toBe(true);
    // Append-only across growth: the prefix projection never mutates an
    // already-emitted segment.
    const partial = projectTranscript([{ type: "assistant_delta", text: "first paragraph.\n\n" }]);
    expect(blocks[0]).toEqual(partial[0]);
    // Loose-list blank lines do not split: the list stays one segment.
    const list = projectTranscript([{ type: "assistant_delta", text: "intro:\n\n- one\n\n- two" }]);
    expect(list.filter((block) => block.markdown?.includes("- one")).length).toBe(1);
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><TranscriptBlockView block={blocks[1]!} width={80} /></ThemeProvider>);
    // Continuations open with the single GFM inter-block blank row, then the
    // body — never a `◆ moh` head row.
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame.startsWith("\n  second")).toBe(true);
    ink.unmount();
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
