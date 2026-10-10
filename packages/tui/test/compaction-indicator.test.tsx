import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
const chalk = createRequire(import.meta.resolve("ink"))("chalk").default as { level: 0 | 1 | 2 | 3 };
import { beforeEach, afterEach } from "bun:test";
let previousColorLevel: typeof chalk.level;
beforeEach(() => { previousColorLevel = chalk.level; chalk.level = 3; });
afterEach(() => { chalk.level = previousColorLevel; });
import React from "react";
import { render } from "ink-testing-library";
import { ThemeProvider, THEMES } from "../src/themes";
import { BottomBar } from "../src/BottomBar";
import { stripAnsi } from "./helpers";
import { SAND_FRAMES } from "../src/icons";

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

describe("#1300 semantic status glyph and animated subagent chips", () => {
  function rawFrame(props: Record<string, unknown>): string {
    const ink = render(
      <ThemeProvider value={THEMES["tron"]}>
        <BottomBar {...base} {...(props as any)} />
      </ThemeProvider>,
    );
    const frame = ink.lastFrame() ?? "";
    ink.unmount();
    return frame;
  }

  test("the settled ✓ done status wears the fixed green, never the theme token", () => {
    const frame = rawFrame({ pending: false, turns: 12 });
    expect(frame).toContain("\u001b[38;2;46;160;67m✓");
    // TRON's ok is cyan #00d9ff.
    expect(frame).not.toContain("\u001b[38;2;0;217;255m✓");
  });

  test("a settled subagent chip takes the semantic color and stays static across frames", () => {
    const chips = [{ label: "a", glyph: "✓", active: false }, { label: "b", glyph: "⏸", active: false }, { label: "c", glyph: "◐", active: false }, { label: "+2", glyph: "", active: false }];
    const frame0 = rawFrame({ subagentChips: chips, frame: 0 });
    const frame9 = rawFrame({ subagentChips: chips, frame: 9 });
    expect(frame0).toContain("\u001b[38;2;46;160;67m✓");
    expect(frame0).toContain(SAND_FRAMES[0]!);
    expect(frame9).toContain(SAND_FRAMES[9]!);
    // ⏸ and the settled ✓ never swap; the over-cap chip keeps its empty slot.
    expect(frame9).toContain("⏸");
    expect(frame9).toContain("\u001b[38;2;46;160;67m✓");
    expect(frame0).toContain("+2");
  });
});

 test("#1300 NO_COLOR suppresses fixed semantic colors even with truecolor support", () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const ink = render(<ThemeProvider value={THEMES.tron}><BottomBar {...base} mode="vibe" subagentChips={[{ label: "done", glyph: "✓", active: false }, { label: "failed", glyph: "✗", active: false }]} /></ThemeProvider>);
    const frame = ink.lastFrame() ?? "";
    ink.unmount();
    expect(frame).toContain("✓");
    expect(frame).toContain("✗");
    expect(frame).not.toMatch(/\x1b\[(?:38|48);/);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
