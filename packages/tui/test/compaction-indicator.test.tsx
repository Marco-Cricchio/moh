import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ThemeProvider, THEMES } from "../src/themes";
import { BottomBar } from "../src/BottomBar";
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

describe("compaction sticky indicator (#466, ADR-0022)", () => {
  test("hidden by default, shown while the flag is set, cleared on success", () => {
    expect(frameOf({})).not.toContain("compaction failed");
    const failed = frameOf({ compactionFailed: true });
    expect(failed).toContain("⚠ compaction failed — retrying");
    // A successful marker clears the flag → no indicator.
    expect(frameOf({ compactionFailed: false })).not.toContain("compaction failed");
  });

  test("compact width shows the ⚠ glyph only", () => {
    const ink = render(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <BottomBar {...base} mode="dev" width={48} compactionFailed />
      </ThemeProvider>,
    );
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("⚠");
    expect(frame).not.toContain("compaction failed — retrying");
    ink.unmount();
  });
});
