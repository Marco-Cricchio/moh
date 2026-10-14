import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pressCommitted, sendPrompt, stripAnsi, waitText } from "./helpers";
import { App } from "../src/App";
import { MockProvider } from "@moh/core";

/**
 * Opens the subagent chip's live panel: Tab into the chip zone, then Enter.
 * Tab only reaches the subagent chip once App's own subagent count — a
 * second, coalesced projection of the session log — has caught up with the
 * chip Chat already paints (it lagged ~400 ms behind the chip locally,
 * #1473). Until then Tab focuses the first action chip and Enter fires it
 * (an empty send: a no-op that returns focus to the composer). The focus
 * move paints nothing in the tests' colorless frame, so the whole Tab →
 * Enter → panel round repeats, with Esc leaving any chip focus between
 * rounds, until the panel shows.
 */
async function openPanel(ink: Parameters<typeof pressCommitted>[0], marker: string): Promise<void> {
  const frame = () => stripAnsi(ink.lastFrame() ?? "");
  for (let round = 1; round <= 10; round++) {
    await pressCommitted(ink, "\t", `tab into the chip zone (round ${round})`);
    await pressCommitted(ink, "\r", `enter on the focused chip (round ${round})`);
    try {
      await waitText(ink, marker, `the live panel opened (round ${round})`, { timeoutMs: 1_000 });
      return;
    } catch {
      await pressCommitted(ink, "\x1b", `esc out of the chip zone (round ${round})`);
    }
  }
  throw new Error(`stuck at step "the live panel opened": no ${JSON.stringify(marker)} after 10 rounds. Last frame:\n${frame()}`);
}

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
    const app = <App intro={false} cwd={cwd} home={home} provider={provider} startInChat skipOnboarding yolo />;
    const ink = render(app);
    Object.defineProperty(ink.stdout, "columns", { value: 170, configurable: true });
    ink.rerender(app);
    try {
      await sendPrompt(ink, "go");
      // The parent emits subagent_spawn before the child gets its first
      // delayed delta: its visible chip proves bridge delivery reached Chat.
      await waitText(ink, "research", "the subagent chip");
      expect(stripAnsi(ink.lastFrame() ?? "")).toContain("research");
      // `▸ task` is the panel's own section (the status bar's "···· running"
      // would match a looser probe).
      await openPanel(ink, "▸ task");
      // The child's first delayed delta reaches the panel through its poll.
      await waitText(ink, "child first", "the first child-log preview");
      const first = stripAnsi(ink.lastFrame() ?? "");
      expect(first).toContain("child first");
      expect(first).not.toContain("result in transcript");
      await waitText(ink, "child first child second", "the second child-log preview");
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
        intro={false}
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
    // Send the task through the composer.
    await sendPrompt(ink, "go");
    // The spawn's chip is up once the bridge delivered the subagent.
    await waitText(ink, "research", "the subagent chip");
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("research");
    // Tab reaches the subagent chip first (head of the cycle); its accent
    // border highlights. Then Enter opens the live panel.
    const focused = stripAnsi(ink.lastFrame() ?? "");
    expect(focused).toContain("research");
    // The mock child finishes fast: the panel shows its settled footer.
    await openPanel(ink, "result in transcript");
    const panelFrame = stripAnsi(ink.lastFrame() ?? "");
    // The panel opened on the right with the child's header (running or
    // already settled — the mock child finishes fast).
    expect(panelFrame.includes("running") || panelFrame.includes("· done")).toBe(true);
    expect(panelFrame).toContain("result in transcript");
    // Esc returns focus to the composer, panel stays.
    await pressCommitted(ink, "\x1b", "esc back to the composer");
    const afterEsc = stripAnsi(ink.lastFrame() ?? "");
    if (!afterEsc.includes("running") && !afterEsc.includes("· done")) {
      console.log("POST-ESC FRAME:\n" + afterEsc);
    }
    expect(afterEsc.includes("running") || afterEsc.includes("· done")).toBe(true);
    expect(afterEsc).toContain("result in transcript");
    ink.unmount();
  }, 20_000);
});
