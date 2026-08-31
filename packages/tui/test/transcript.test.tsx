import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { AgentEvent } from "@moh/core";
import { blockTint, projectTranscript, assistantSegments, capReasoningText, closedPrefixLength, REASONING_DISPLAY_CAP, TranscriptBlockView } from "../src/transcript";
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

describe("render-side sanitizer (SEC-08)", () => {
  test("strips terminal controls from argument details and output previews without changing line breaks", () => {
    const raw = "echo safe\u001b[2K\u001b[1A\nnext";
    const blocks = projectTranscript([
      { type: "tool_call", callId: "c", name: "bash", args: { command: raw } },
      { type: "tool_result", callId: "c", ok: true, output: `result\u001b[2K\nnext` },
    ], { mode: "dev" });
    const block = blocks.find((item) => item.type === "bash")!;
    expect(block.detail).toBe("echo safe");
    expect(block.lines).toEqual(["result", "next"]);
    expect(raw).toContain("\u001b[2K"); // the event bytes are never rewritten
    expect(projectTranscript([{ type: "assistant_delta", text: "reply\u001b[2K\nnext" }])[0]?.lines).toEqual(["reply", "next"]);
  });

  test("sanitizes ask_user question and answer previews", () => {
    const blocks = projectTranscript([
      { type: "tool_call", callId: "ask", name: "ask_user", args: { question: "Choose\u009b2K now" } },
      { type: "tool_result", callId: "ask", ok: true, output: "yes\u001b[2K" },
    ]);
    expect(blocks.find((item) => item.type === "ask")?.lines).toEqual(["Choose now", "↳ you: yes"]);
  });
});

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

  test("tight lists split per item and promote while streaming; loose lists stay whole (#226)", () => {
    const tight = "Riepilogo:\n\n1. primo punto\n2. secondo punto\n3. terzo punto";
    const segments = assistantSegments(tight);
    // intro paragraph + one segment per list item
    expect(segments.length).toBe(4);
    const partial = "Riepilogo:\n\n1. primo punto\n2. secondo";
    // item 1 is final while item 2 still streams (settled boundary may promote it)
    expect(closedPrefixLength(partial)).toBe("Riepilogo:\n\n1. primo punto\n".length);
    // projection marks item continuations tight: no blank row between items
    const blocks = projectTranscript([{ type: "assistant_delta", text: tight }]);
    expect(blocks.filter((b) => b.tight).length).toBe(2);
    expect(blocks.filter((b) => b.continuation && !b.tight).length).toBe(1);
  });

  test("split ordered lists keep their literal numbering when rendered (#226)", () => {
    const text = "1. primo punto\n2. secondo punto\n3. terzo punto";
    const blocks = projectTranscript([{ type: "assistant_delta", text }]);
    expect(blocks.length).toBe(3);
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><TranscriptBlockView block={blocks[2]!} width={80} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("3. terzo punto");
    ink.unmount();
  });

  test("a trailing blank line does not close a prefix that may still grow (#227)", () => {
    // A delta ending in \n used to promote its segment immediately; the
    // next table/list row then grew a Static-printed block — raw header
    // printed, following rows lost forever.
    expect(closedPrefixLength("| PR | Issue |\n")).toBe(0);
    expect(closedPrefixLength("| PR | Issue |\n|---|---|---|\n")).toBe(0);
    expect(closedPrefixLength("| PR | Issue |\n|---|---|---|\n| #212 | #211 | x |\n")).toBe(0);
    // An internal blank (content follows) still closes — one delta later
    // than before, when the next paragraph's first text arrives.
    expect(closedPrefixLength("para\n\nnext")).toBe("para\n\n".length);
    // A real blank line that ends the run closes too (the paragraph cannot
    // be extended): promotion timing for paragraph-ending deltas is kept.
    expect(closedPrefixLength("para\n\n")).toBe("para\n\n".length);
    // …but a loose-list separator must not split a list that continues.
    expect(closedPrefixLength("- uno\n\n")).toBe(0);
    expect(closedPrefixLength("- uno\n\n- due")).toBe(0);
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

describe("provider reasoning projection (#242)", () => {
  test("hidden by default; enabling display renders historical model-labelled reasoning", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "why?" },
      { type: "assistant_delta", text: "because" },
      { type: "reasoning", text: "first premise" },
      { type: "reasoning", text: "second premise" },
      { type: "model_call", model: "anthropic/claude", usage: { inputTokens: 1, outputTokens: 2 }, thinkingLevel: "high" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, models: ["anthropic/claude"] },
    ];
    expect(projectTranscript(events).some((block) => block.kind === "thinking")).toBe(false);

    const thinking = projectTranscript(events, { showReasoning: true }).find((block) => block.kind === "thinking")!;
    expect(thinking.glyph).toBe("⋯");
    expect(thinking.detail).toBe("· anthropic/claude");
    expect(thinking.lines).toEqual(["first premise", "", "second premise"]);
    // Several persisted parts are one call-level display block.
    expect(projectTranscript(events, { showReasoning: true }).filter((block) => block.kind === "thinking")).toHaveLength(1);
  });

  test("failed calls retain reasoning with an error state", () => {
    const events: AgentEvent[] = [
      { type: "reasoning", text: "diagnostic thought" },
      { type: "model_call", model: "provider/model", usage: { inputTokens: 1, outputTokens: 0 } },
      { type: "error", reason: "provider_failure", message: "boom" },
    ];
    const blocks = projectTranscript(events, { showReasoning: true });
    expect(blocks[0]).toMatchObject({ kind: "thinking", state: "fail", detail: "· provider/model · failed" });
    expect(blocks[1]).toMatchObject({ kind: "error", state: "fail" });
  });

  test("fallback call failures still mark their reasoning block failed", () => {
    const blocks = projectTranscript([
      { type: "fallback", from: "primary/model", to: "backup/model", reason: "overloaded" },
      { type: "reasoning", text: "backup diagnostic" },
      { type: "model_call", model: "backup/model", usage: { inputTokens: 1, outputTokens: 0 } },
      { type: "error", reason: "provider_failure", message: "backup failed" },
    ], { showReasoning: true });
    expect(blocks.find((block) => block.kind === "thinking")).toMatchObject({ state: "fail", detail: "· backup/model · failed" });

    const primary = projectTranscript([
      { type: "fallback", from: "primary/model", to: "backup/model", reason: "overloaded" },
      { type: "reasoning", text: "primary diagnostic" },
      { type: "model_call", model: "primary/model", usage: { inputTokens: 1, outputTokens: 0 } },
      { type: "assistant_delta", text: "backup succeeded" },
    ], { showReasoning: true }).find((block) => block.kind === "thinking");
    expect(primary).toMatchObject({ state: "fail", detail: "· primary/model · failed" });
  });

  test("64 KiB call buffer is tail-capped visibly without mutating logged data", () => {
    const full = `discard-me-${"a".repeat(REASONING_DISPLAY_CAP)}TAIL`;
    const event: AgentEvent = { type: "reasoning", text: full };
    const capped = capReasoningText(full);
    expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(REASONING_DISPLAY_CAP);
    expect(capped).toStartWith("… reasoning truncated");
    expect(capped).toEndWith("TAIL");
    expect(event.text).toBe(full); // projection never truncates persisted/history data

    const blocks = projectTranscript([
      event,
      { type: "model_call", model: "big/model", usage: { inputTokens: 0, outputTokens: 0 } },
    ], { showReasoning: true });
    expect(blocks[0]?.lines.join("\n")).toBe(capped);
    expect(new TextEncoder().encode(capReasoningText("🧠".repeat(REASONING_DISPLAY_CAP))).byteLength).toBeLessThanOrEqual(REASONING_DISPLAY_CAP);

    const tabs = "\t".repeat(REASONING_DISPLAY_CAP);
    const tabBlock = projectTranscript([
      { type: "reasoning", text: tabs },
      { type: "model_call", model: "big/model", usage: { inputTokens: 0, outputTokens: 0 } },
    ], { showReasoning: true })[0]!;
    expect(new TextEncoder().encode(tabBlock.lines.join("\n")).byteLength).toBeLessThanOrEqual(REASONING_DISPLAY_CAP);
  });

  test("reasoning rendering obeys narrow width wrapping", () => {
    const block = projectTranscript([
      { type: "reasoning", text: "one two three four five six seven eight nine ten" },
      { type: "model_call", model: "wide/provider-model-name", usage: { inputTokens: 0, outputTokens: 0 } },
    ], { showReasoning: true })[0]!;
    const rendered = render(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <TranscriptBlockView block={block} width={28} />
      </ThemeProvider>,
    );
    const rows = stripAnsi(rendered.lastFrame() ?? "").split("\n");
    expect(rows.every((row) => row.length <= 27)).toBe(true);
    expect(rows.join("\n")).toContain("thinking");
  });
});

describe("subagent block (#320)", () => {
  test("spawn + result project as ONE block with final state, tokens and preview", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abcdef123456" },
      { type: "subagent_spawn", callId: "s1", name: "worker", preset: "research", log: "/tmp/log" },
      { type: "subagent_result", callId: "s1", name: "worker", status: "done", usage: { inputTokens: 3000, outputTokens: 9000 }, log: "/tmp/log", preview: "found the seam\napplied the fix" },
    ];
    const blocks = projectTranscript(events);
    const sub = blocks.filter((b) => b.kind === "subagent");
    expect(sub).toHaveLength(1);
    expect(sub[0]!.type).toBe("worker");
    expect(sub[0]!.detail).toContain("research");
    expect(sub[0]!.detail).toContain("done");
    expect(sub[0]!.detail).toContain("12.0k tok");
    expect(sub[0]!.lines).toContain("found the seam");
    expect(sub[0]!.state).toBe("ok");
  });

  test("a spawned-but-unfinished subagent renders running (volatile, never settled)", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abcdef123456" },
      { type: "subagent_spawn", callId: "s1", name: "worker", log: "/tmp/log" },
    ];
    const blocks = projectTranscript(events);
    const sub = blocks.find((b) => b.kind === "subagent");
    expect(sub?.state).toBe("run");
    expect(sub?.detail).toContain("running");
  });

  test("a failed subagent keeps its error visible in both modes", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abcdef123456" },
      { type: "subagent_spawn", callId: "s1", name: "worker", log: "/tmp/log" },
      { type: "subagent_result", callId: "s1", name: "worker", status: "error", usage: { inputTokens: 1, outputTokens: 1 }, log: "/tmp/log" },
    ];
    for (const mode of ["vibe", "dev"] as const) {
      const sub = projectTranscript(events, { mode }).find((b) => b.kind === "subagent");
      expect(sub?.state).toBe("fail");
    }
  });

  test("vibe shows subagent runs as a single plain-language line, failures excepted", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abcdef123456" },
      { type: "subagent_spawn", callId: "s1", name: "worker", log: "/tmp/log" },
      { type: "subagent_result", callId: "s1", name: "worker", status: "done", usage: { inputTokens: 3, outputTokens: 4 }, log: "/tmp/log", preview: "summary line" },
    ];
    const sub = projectTranscript(events, { mode: "vibe" }).find((b) => b.kind === "subagent");
    expect(sub?.lines.join(" ")).toContain("worker");
    expect(sub?.state).toBe("ok");
  });
});
