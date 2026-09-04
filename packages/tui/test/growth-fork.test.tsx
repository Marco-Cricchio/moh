import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ThemeProvider, THEMES } from "../src/themes";
import { BottomBar } from "../src/BottomBar";
import { BASE_COMMANDS } from "../src/commands";
import { stripAnsi } from "./helpers";

const base = {
  width: 120,
  pending: false,
  spinner: "⠸",
  model: "mock",
  turns: 12,
  tokens: { contextIn: 10_000, totalOut: 100, calls: 1 },
  level: "medium" as const,
  focusedChip: null,
};

function frameOf(props: Record<string, unknown>): string {
  const ink = render(
    <ThemeProvider value={THEMES["tokyo-night"]}>
      <BottomBar {...base} {...(props as any)} />
    </ThemeProvider>,
  );
  const frame = stripAnsi(ink.lastFrame() ?? "");
  ink.unmount();
  return frame;
}

describe("growth warning sticky indicator (#468, ADR-0020)", () => {
  test("hidden by default; incidents count, never stack", () => {
    expect(frameOf({})).not.toContain("file grew externally");
    const once = frameOf({ growthWarning: 1 });
    expect(once).toContain("⚡ file grew externally ×1 — /fork");
    // A second incident updates the counter on the same indicator.
    const twice = frameOf({ growthWarning: 2 });
    expect(twice).toContain("×2");
    expect(twice.match(/file grew externally/g)?.length).toBe(1);
    // Cleared by the fork (count null) → gone.
    expect(frameOf({ growthWarning: null })).not.toContain("file grew externally");
  });

  test("compact width shows the ⚡ glyph only", () => {
    const ink = render(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <BottomBar {...base} mode="dev" width={48} growthWarning={1} />
      </ThemeProvider>,
    );
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("⚡");
    expect(frame).not.toContain("file grew externally");
    ink.unmount();
  });
});

describe("/fork command gating (#468, ADR-0020)", () => {
  test("the command exists in BASE_COMMANDS (alphabetical order)", () => {
    const names = BASE_COMMANDS.map((c) => c.name);
    expect(names).toContain("fork");
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  test("refuses outside the growth-warning state — no general fork", () => {
    const notices: string[] = [];
    BASE_COMMANDS.find((c) => c.name === "fork")!.run({
      session: {} as any,
      notify: (t: string) => notices.push(t),
      config: { workflow: { enabled: false } } as any,
      mohHome: "/tmp",
      cwd: "/tmp",
      // no growthWarning → refused
    } as any);
    expect(notices[0]).toContain("only while the session-file-growth warning is active");
  });

  test("invokes onForkNow while the warning is active", () => {
    let called = false;
    BASE_COMMANDS.find((c) => c.name === "fork")!.run({
      session: {} as any,
      notify: () => {},
      config: { workflow: { enabled: false } } as any,
      mohHome: "/tmp",
      cwd: "/tmp",
      growthWarning: () => true,
      onForkNow: () => { called = true; },
    } as any);
    expect(called).toBe(true);
  });
});
