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
    // One `model` line closes the turn; no usage line and no per-call model blocks (#213).
    const dev = projectTranscript(base, { mode: "dev" });
    expect(dev.filter((block) => block.type === "model").map((block) => block.detail)).toEqual(["mock"]);
    expect(dev.some((block) => block.type === "usage" || block.usage)).toBe(false);
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
    expect(plain.map((block) => block.lines[0])).toContain("ran a command · rm");
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



  test("auto-accept grants are ambient noise; explicit grants and denials still show (#215)", () => {
    const events: AgentEvent[] = [
      { type: "permission_requested", callId: "p1", tool: "bash" },
      { type: "permission_granted", callId: "p1", tool: "bash", reason: "auto_accept" },
      { type: "permission_requested", callId: "p2", tool: "bash" },
      { type: "permission_granted", callId: "p2", tool: "bash", reason: "bypass" },
      { type: "permission_granted", callId: "p3", tool: "bash", reason: "user" },
      { type: "permission_denied", callId: "p4", tool: "bash", reason: "user" },
    ];
    for (const mode of ["dev", "vibe"] as const) {
      const blocks = projectTranscript(events, { mode });
      expect(blocks.filter((block) => block.type === "permission" && block.state === "ok").map((block) => block.detail)).toEqual(["bash · allowed (user)"]);
      expect(blocks.some((block) => block.type === "permission" && block.state === "fail")).toBe(true);
    }
  });

  test("vibe command hint is a short synthesis, never the full command line (#215)", () => {
    const events: AgentEvent[] = [
      { type: "tool_call", callId: "h1", name: "bash", args: { command: "FOO=1 bun test packages/tui" } },
      { type: "tool_call", callId: "h2", name: "bash", args: { command: "git status --porcelain -b" } },
      { type: "tool_call", callId: "h3", name: "bash", args: { command: "/usr/bin/git log --oneline" } },
    ];
    const lines = projectTranscript(events, { mode: "vibe" }).filter((block) => block.lines.length === 1).map((block) => block.lines[0]);
    expect(lines).toContain("ran a command · bun test");
    expect(lines).toContain("ran a command · git status");
    expect(lines).toContain("ran a command · git log");
    expect(lines.some((line) => line.includes("--porcelain") || line.includes("FOO=1") || line.includes("/usr/bin"))).toBe(false);
  });

  test("fetch collapses to a plain-language line in both modes; failures show (#219)", () => {
    const ok: AgentEvent[] = [
      { type: "tool_call", callId: "d1", name: "fetch", args: { url: "https://example.com/doc" } },
      { type: "tool_result", callId: "d1", ok: true, output: "<html>" + "x".repeat(9_000) },
    ];
    for (const mode of ["dev", "vibe"] as const) {
      const blocks = projectTranscript(ok, { mode });
      const fetch = blocks.find((block) => block.lines.length === 1 && block.lines[0]!.startsWith("fetched a page"));
      expect(fetch?.lines[0]).toBe("fetched a page · https://example.com/doc");
      expect(blocks.some((block) => block.type === "fetch" && block.lines.length > 0)).toBe(false);
    }
    const fail: AgentEvent[] = [
      { type: "tool_call", callId: "d2", name: "fetch", args: { url: "https://example.com/missing" } },
      { type: "tool_result", callId: "d2", ok: false, output: "HTTP 404" },
    ];
    const failed = projectTranscript(fail, { mode: "dev" }).find((block) => block.state === "fail");
    expect(failed?.lines).toContain("HTTP 404");
  });

  test("long body lines render once — no duplicated tail across wrap rows", () => {
    const question = `Q6 — Le ~10 skill portate entrano nel circuito workflow-mode esistente, con ask-moh che resta comando base sempre disponibile e nothing else matters here to force wrap`;
    const events: AgentEvent[] = [
      { type: "tool_call", callId: "q1", name: "ask_user", args: { question } },
      { type: "tool_result", callId: "q1", ok: true, output: "sì" },
    ];
    const block = projectTranscript(events)[0]!;
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><TranscriptBlockView block={block} width={70} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    const tail = "comando base sempre";
    expect(frame.split(tail).length - 1).toBe(1);
    expect(frame.split("↳ you: sì").length - 1).toBe(1);
    ink.unmount();
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
    expect(blocks.some((block) => block.type === "model" && block.detail === "mock")).toBe(true);
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
    expect(projectTranscript([{ type: "done", models: ["m"] }])[0]?.type).toBe("model");
    expect(projectTranscript([{ type: "done" }]).length).toBe(0);
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
    expect(frame.startsWith("\n    second")).toBe(true);
    ink.unmount();
  });

  test("wraps long head detail and body lines into their own rows (#213)", () => {
    const long = "cmd-" + "x".repeat(100);
    const blocks = projectTranscript([{ type: "tool_call", callId: "w1", name: "bash", args: { command: long } }], { mode: "dev" });
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><TranscriptBlockView block={blocks[0]!} width={60} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    // The full command survives across rows; continuation rows are indented under the label.
    expect(frame).toContain("bash cmd-");
    expect(frame.split("\n").filter((line) => line.includes("xxxxx"))).toHaveLength(2);
    ink.unmount();
  });

  test("renders the validated head/body/gap grammar with tint and no transcript frame", () => {
    const block = projectTranscript([{ type: "user_message", text: "select this cleanly" }])[0]!;
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><TranscriptBlockView block={block} width={80} /></ThemeProvider>);
    const raw = ink.lastFrame() ?? "";
    const clean = stripAnsi(raw);
    expect(clean).toContain("› you");
    // Head sits directly above its body, indented 4 under the type label (#211).
    expect(clean).toContain("    select this cleanly");
    expect(clean).not.toMatch(/[┌┐└┘╭╮╰╯]/);
    expect(blockTint(block, THEMES["tokyo-night"])).not.toBe(THEMES["tokyo-night"].bg);
    expect(blockTint({ key: "cot", kind: "thinking", glyph: "⋯", type: "thinking", lines: ["inner"] }, THEMES["tokyo-night"])).toBeUndefined();
    ink.unmount();
  });
});
