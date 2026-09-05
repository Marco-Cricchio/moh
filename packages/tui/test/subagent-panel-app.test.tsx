import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
import { App } from "../src/App";
import { MockProvider } from "@moh/core";

/**
 * Integration (#497): a real spawn through the session → chips appear in
 * the footer, tab reaches the subagent chip, Enter opens the live panel.
 */
describe("subagent chips + panel integration", () => {
  test("streams child-log previews into the open panel before subagent_result", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-subs-stream-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "moh-subs-stream-cwd-"));
    // One provider is deliberately shared by the parent and child: call 1
    // spawns, call 2 is the still-running child, call 3 resumes the parent.
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "stream slowly" } }] },
      { deltas: ["child first ", "child second ", "child third ", "child fourth"], deltaDelayMs: 600, finish: "stop", usage: { inputTokens: 10, outputTokens: 10 } },
      { deltas: ["parent finished"], finish: "stop" },
    ]);
    const app = <App cwd={cwd} home={home} provider={provider} startInChat skipOnboarding yolo />;
    const ink = render(app);
    Object.defineProperty(ink.stdout, "columns", { value: 170, configurable: true });
    ink.rerender(app);
    try {
      await sleep(50);
      ink.stdin.write("go");
      await sleep(30);
      ink.stdin.write("\r");
      // The parent emits subagent_spawn before the child gets its first
      // delayed delta. Retry only until its visible chip proves that bridge
      // delivery has reached Chat.
      for (let i = 0; i < 20 && !stripAnsi(ink.lastFrame() ?? "").includes("research"); i++) await sleep(25);
      expect(stripAnsi(ink.lastFrame() ?? "")).toContain("research");
      // Ink needs one reconciliation between Tab (enter chip zone) and
      // Enter (toggle panel); real terminal keypresses naturally provide it.
      ink.stdin.write("\t");
      await sleep(60);
      ink.stdin.write("\r");
      await sleep(700); // child first delta + one 350ms poll
      const first = stripAnsi(ink.lastFrame() ?? "");
      expect(first).toContain("child first");
      expect(first).not.toContain("result in transcript");
      await sleep(700); // child second delta + another poll, still pre-result
      const second = stripAnsi(ink.lastFrame() ?? "");
      expect(second).toContain("child first child second");
      expect(second).not.toContain("result in transcript");
    } finally {
      ink.unmount();
    }
  }, 20_000);

  test("spawn shows a chip; tab/Enter open the live panel", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-subs-ui-"));
    const cwd = mkdtempSync(join(tmpdir(), "moh-subs-cwd-"));
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "find it" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const app = (
      <App
        cwd={cwd}
        home={home}
        provider={provider}
        startInChat
        skipOnboarding
        yolo
      />
    );
    const ink = render(app);
    Object.defineProperty(ink.stdout, "columns", { value: 170, configurable: true });
    ink.rerender(app);
    await sleep(50);
    // Send the task through the composer.
    ink.stdin.write("go");
    await sleep(30);
    ink.stdin.write("\r");
    // Wait for the child to finish.
    await sleep(1200);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("research");
    // Tab reaches the subagent chip first (head of the cycle); its accent
    // border highlights. Then Enter opens the live panel.
    ink.stdin.write("\t");
    await sleep(120);
    const focused = stripAnsi(ink.lastFrame() ?? "");
    expect(focused).toContain("research");
    ink.stdin.write("\r");
    await sleep(120);
    const panelFrame = stripAnsi(ink.lastFrame() ?? "");
    // The panel opened on the right with the child's header (running or
    // already settled — the mock child finishes fast).
    expect(panelFrame.includes("running") || panelFrame.includes("· done")).toBe(true);
    expect(panelFrame).toContain("result in transcript");
    // Esc returns focus to the composer, panel stays.
    ink.stdin.write("\x1b");
    await sleep(120);
    const afterEsc = stripAnsi(ink.lastFrame() ?? "");
    if (!afterEsc.includes("running") && !afterEsc.includes("· done")) {
      console.log("POST-ESC FRAME:\n" + afterEsc);
    }
    expect(afterEsc.includes("running") || afterEsc.includes("· done")).toBe(true);
    expect(afterEsc).toContain("result in transcript");
    ink.unmount();
  }, 20_000);
});
