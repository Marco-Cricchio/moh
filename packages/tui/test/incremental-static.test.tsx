import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@moh/core";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { settledBoundary } from "../src/Chat";
import { projectTranscript } from "../src/transcript";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("settledBoundary — incremental Static promotion (#194)", () => {
  test("idle sessions settle everything", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "ok" },
      { type: "done" },
    ];
    expect(settledBoundary(events, false)).toBe(events.length);
  });

  test("an unfinished streaming tail stays volatile", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "model_call", model: "mock", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "assistant_delta", text: "str" },
      { type: "assistant_delta", text: "eam" },
    ];
    // Only the user_message block is promoted; the paragraph is still open.
    expect(settledBoundary(events, true)).toBe(1);
  });

  test("a closed paragraph promotes: a blank line finalizes the prose before it", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "first paragraph done\n\n" },
      { type: "assistant_delta", text: "second (still streaming" },
    ];
    expect(settledBoundary(events, true)).toBe(2);
  });

  test("an open code fence blocks promotion until it closes", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "intro\n\n```ts\nconst a = 1;\n" },
      { type: "assistant_delta", text: "const b = 2;\n" },
    ];
    expect(settledBoundary(events, true)).toBe(1);
    const closed: AgentEvent[] = [
      ...events,
      { type: "assistant_delta", text: "```\n\n" },
      { type: "assistant_delta", text: "done" },
    ];
    // The fence-closing paragraph (ending at the blank line) promotes;
    // the trailing "done" paragraph stays volatile.
    expect(settledBoundary(closed, true)).toBe(4);
  });

  test("a completed tool pair closes the prefix — earlier deltas are promoted with it", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "model_call", model: "mock", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "assistant_delta", text: "checking…" },
      { type: "tool_call", callId: "a", name: "glob", args: { pattern: "*.ts" } },
      { type: "tool_result", callId: "a", ok: true, output: "one.ts" },
      { type: "assistant_delta", text: "still streaming" },
    ];
    // Everything through the tool_result is closed; the new delta is not.
    expect(settledBoundary(events, true)).toBe(5);
  });

  test("a pending tool_call keeps the prefix volatile until its result arrives", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "tool_call", callId: "a", name: "glob", args: { pattern: "*.ts" } },
      { type: "tool_call", callId: "b", name: "glob", args: { pattern: "*.tsx" } },
      { type: "tool_result", callId: "a", ok: true, output: "one.ts" },
    ];
    // b is still open — nothing past the user_message may be promoted.
    expect(settledBoundary(events, true)).toBe(1);
  });

  test("parallel calls close together when the last result lands", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "tool_call", callId: "a", name: "glob", args: { pattern: "*.ts" } },
      { type: "tool_call", callId: "b", name: "glob", args: { pattern: "*.tsx" } },
      { type: "tool_result", callId: "a", ok: true, output: "one.ts" },
      { type: "tool_result", callId: "b", ok: true, output: "two.tsx" },
    ];
    expect(settledBoundary(events, true)).toBe(5);
  });

  test("a stray result without its call promotes only itself (clamp prevents under-count)", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "tool_result", callId: "ghost", ok: true, output: "?" },
      { type: "tool_call", callId: "a", name: "glob", args: { pattern: "*.ts" } },
    ];
    // The orphan result is a complete event (rendered as an orphan block)
    // and may settle; the following pending tool_call keeps the rest live.
    expect(settledBoundary(events, true)).toBe(2);
  });

  test("done closes the whole turn", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "reply" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, models: ["mock"] },
    ];
    expect(settledBoundary(events, true)).toBe(3);
  });

  test("the emitted Static prefix is content-stable across GLM-style split fences", () => {
    // Minimized from 20260825T171016939Z-959fcc92: GLM split both fence
    // delimiters across deltas after a completed read action.
    const events: AgentEvent[] = [
      { type: "user_message", text: "inspect" },
      { type: "model_call", model: "openai-compat/glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "tool_call", callId: "read-1", name: "read", args: { path: "README.md" } },
      { type: "tool_result", callId: "read-1", ok: true, output: "excerpt" },
      { type: "assistant_delta", text: "Here is the excerpt:\n\n" },
      { type: "assistant_delta", text: "``" },
      { type: "assistant_delta", text: "`\n" },
      { type: "assistant_delta", text: "# heading\n\nbody\n" },
      { type: "assistant_delta", text: "``" },
      { type: "assistant_delta", text: "`\n\n" },
      { type: "model_call", model: "openai-compat/glm-5.3", usage: { inputTokens: 2, outputTokens: 2 } },
      { type: "done", usage: { inputTokens: 3, outputTokens: 3 }, models: ["openai-compat/glm-5.3"] },
    ];
    let emitted: ReturnType<typeof projectTranscript> = [];
    for (let length = 1; length <= events.length; length++) {
      const boundary = settledBoundary(events.slice(0, length), true);
      const staticItems = projectTranscript(events.slice(0, boundary), { mode: "dev" });
      // Static cannot revise already printed items: its next projection must
      // keep every emitted item byte-for-byte at the same array index.
      expect(staticItems.slice(0, emitted.length)).toEqual(emitted);
      emitted = staticItems;
    }
  });

  test("the boundary is monotonic as events append (no Static item ever re-opens)", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "para\n\n" },
      { type: "tool_call", callId: "a", name: "glob", args: { pattern: "*.ts" } },
      { type: "assistant_delta", text: "more\n\n" },
      { type: "tool_result", callId: "a", ok: true, output: "one.ts" },
      { type: "assistant_delta", text: "tail" },
      { type: "done" },
    ];
    let previous = 0;
    for (let length = 1; length <= events.length; length++) {
      const boundary = settledBoundary(events.slice(0, length), true);
      expect(boundary).toBeGreaterThanOrEqual(previous);
      previous = boundary;
    }
    expect(previous).toBe(events.length);
  });
});

describe("open-turn scrollback is scrollable mid-turn (#194)", () => {
  test("a completed tool result is emitted to Static while the turn is still streaming", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-incremental-"));
    const provider = MockProvider.scripted([
      { deltas: ["looking…"], finish: "tool_calls", toolCalls: [{ name: "glob", args: { pattern: "*.md" } }] },
      // Long slow final reply: the turn stays pending well after the tool result settled.
      { deltas: Array.from({ length: 30 }, (_, i) => `streaming-word-${i} `), deltaDelayMs: 40, finish: "stop" },
    ]);
    const app = <App cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />;
    const ink = render(app);
    Object.defineProperty(ink.stdout, "columns", { value: 120, configurable: true });
    Object.defineProperty(ink.stdout, "rows", { value: 40, configurable: true });
    ink.rerender(app);
    await sleep(30);
    ink.stdin.write("check files");
    await sleep(20);
    ink.stdin.write("\r");
    // Poll (no fixed sleeps): the promoted tool block must be visible while
    // the turn is still pending — "thinking" rides the pending status bar.
    const deadline = Date.now() + 4000;
    let midTurn: string | null = null;
    while (Date.now() < deadline) {
      const frame = stripAnsi(ink.lastFrame() ?? "");
      if (frame.includes("looked for files · *.md") && frame.includes("thinking") && frame.includes("streaming-word-0")) {
        midTurn = frame;
        break;
      }
      await sleep(50);
    }
    expect(midTurn).toBeTruthy();
    await sleep(1500);
    const settled = stripAnsi(ink.lastFrame() ?? "");
    // After settle, exactly one promoted tool block — no Static duplication.
    expect(settled.split("looked for files").length - 1).toBe(1);
    ink.unmount();
  }, 15000);
});
