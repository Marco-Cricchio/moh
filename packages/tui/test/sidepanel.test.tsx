import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import type { TrackerBackend } from "@moh/core";
import { Dashboard } from "../src/Dashboard";
import { SidePanel } from "../src/SidePanel";
import { THEME_ORDER, THEMES, ThemeProvider } from "../src/themes";
import type { SidebarState } from "../src/sidebar";
import { centerWidth } from "../src/viewport";
import { stripAnsi } from "./helpers";

/** Forces the viewport hook's terminal size (ink-testing-library has no size option). */
function atSize(columns: number, rows: number, ui: React.ReactNode) {
  const i = render(<ThemeProvider value={THEMES[THEME_ORDER[0]]}>{ui}</ThemeProvider>);
  Object.defineProperty(i.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(i.stdout, "rows", { value: rows, configurable: true });
  i.rerender(<ThemeProvider value={THEMES[THEME_ORDER[0]]}>{ui}</ThemeProvider>);
  return i;
}

const backend: TrackerBackend = {
  kind: "gh",
  list: async () => [
    { id: "1", title: "claimed one", state: "open", labels: [], assignees: ["me"], blockedBy: [] },
    { id: "2", title: "ready one", state: "open", labels: [], assignees: [], blockedBy: [] },
    { id: "3", title: "blocked one", state: "open", labels: [], assignees: [], blockedBy: ["4"] },
    { id: "4", title: "blocker", state: "open", labels: [], assignees: ["me"], blockedBy: [] },
  ],
  claim: async () => {},
};

const state = (activity: SidebarState["activity"], tokens: SidebarState["tokens"] = { contextIn: 50_000, totalOut: 3_000, calls: 12 }): SidebarState => ({ activity, tokens });

const CENTER = (
  <Box flexGrow={1}>
    <Text>center</Text>
  </Box>
);

describe("SidePanel (issue #118)", () => {
  test("renders Activity, Workflow frontier counts and the Tokens bar from the feed", async () => {
    const i = atSize(
      100,
      30,
      <SidePanel state={state([{ kind: "tool", name: "bash", detail: "bun test packages/tui", ok: true }, { kind: "subagent", name: "research", status: "running" }])} backend={backend} workflowOn rows={24} width={20} />,
    );
    await new Promise((r) => setTimeout(r, 20)); // tracker list resolves
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Activity");
    expect(frame).toContain("bash");
    expect(frame).toContain("bun test pa");
    expect(frame).toContain("sub research");
    expect(frame).toContain("claimed");
    expect(frame).toContain("ready");
    expect(frame).toContain("blocked");
    expect(frame).toContain("Tokens");
    expect(frame).toContain("50,000 in · 3,000 out · 12 calls");
    expect(frame).toContain("25%");
    i.unmount();
  });

  test("workflow off: the section says so instead of loading a tracker", async () => {
    const i = atSize(100, 30, <SidePanel state={state([])} backend={null} workflowOn={false} rows={24} width={20} />);
    await new Promise((r) => setTimeout(r, 20));
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("off (/workflow on)");
    expect(frame).not.toContain("claimed");
    i.unmount();
  });

  test("internal windowing: only the most recent activity fits, the panel never exceeds its rows", async () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ kind: "tool" as const, name: `t${n}`, detail: "", ok: true }));
    const i = atSize(100, 30, <SidePanel state={state(many)} backend={backend} workflowOn rows={24} width={20} />);
    await new Promise((r) => setTimeout(r, 20));
    const lines = stripAnsi(i.lastFrame() ?? "").split("\n");
    const painted = lines.filter((l) => l.trim().length > 0);
    // Budget is 14 rows minus the "↑ N more" indicator row → last 13 items (t27…t39), 27 hidden.
    expect(painted.some((l) => l.includes("↑ 27 more"))).toBe(true);
    expect(painted.some((l) => l.includes("t39"))).toBe(true); // newest visible
    expect(painted.some((l) => l.includes("t12"))).toBe(false); // oldest dropped
    // Panel budget: 2 borders + content ≤ rows.
    expect(painted.length).toBeLessThanOrEqual(24);
    i.unmount();
  });
});

describe("vibe mode hides the right sidebar (spec D6, issue #118)", () => {
  test("dev: sections present; vibe: sidebar gone, no section text", async () => {
    const dev = atSize(100, 30, (
      <Dashboard modelLabel="mock" right={<SidePanel state={state([])} backend={null} workflowOn={false} rows={24} width={20} />}>
        {CENTER}
      </Dashboard>
    ));
    const devFrame = stripAnsi(dev.lastFrame() ?? "");
    expect(devFrame).toContain("Activity");
    expect(devFrame).toContain("Tokens");
    dev.unmount();

    const vibe = atSize(100, 30, <Dashboard modelLabel="mock">{CENTER}</Dashboard>);
    const vibeFrame = stripAnsi(vibe.lastFrame() ?? "");
    expect(vibeFrame).not.toContain("Activity");
    expect(vibeFrame).not.toContain("Workflow");
    expect(vibeFrame).not.toContain("Tokens");
    vibe.unmount();
  });

  test("the center column widens when the sidebar is hidden", () => {
    const v = { columns: 100, rows: 30 };
    expect(centerWidth(v, false)).toBeGreaterThan(centerWidth(v, true));
    expect(centerWidth(v, false)).toBe(v.columns - 16 - 2); // menu + gaps only
  });
});
