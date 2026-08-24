import { describe, expect, it } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { fitRow } from "../src/viewport";
import { BottomBar, ThinkingSeparator, fitStatusSegments, visibleChips, widthClass183 } from "../src/BottomBar";
import { ThemeProvider, THEMES } from "../src/themes";
import { stripAnsi } from "./helpers";

const terminalWidth = (text: string): number => {
  const chars = Array.from(text);
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0)!;
    if (cp === 0xfe0f) continue;
    width += cp >= 0x1f000 || chars[i + 1]?.codePointAt(0) === 0xfe0f ? 2 : 1;
  }
  return width;
};

describe("native scrollback layout geometry", () => {
  it("drops optional segments before wrapping", () => {
    expect(fitRow([
      { text: "live" },
      { text: "context 80%" },
      { text: "model", optional: true },
    ], 16)).toEqual(["live", "context 80%"]);
  });

  it("truncates required final segments", () => {
    expect(fitRow([{ text: "ready" }, { text: "0123456789" }], 8)).toEqual(["ready", "01"]);
  });

  it("uses the validated compact/regular/wide breakpoints", () => {
    expect([35, 69, 70, 109, 110, 140].map(widthClass183)).toEqual(["compact", "compact", "regular", "regular", "wide", "wide"]);
  });

  it("degrades chips graphic → compact → drop without exceeding the row budget", () => {
    expect(visibleChips(140).graphic).toBe(true);
    expect(visibleChips(90).graphic).toBe(false);
    expect(visibleChips(35).chips.length).toBeLessThan(4);
    for (let columns = 35; columns <= 140; columns++) {
      const { chips, graphic } = visibleChips(columns);
      const used = chips.reduce((sum, chip) => sum + 5 + chip.key.length + chip.label.length + (graphic ? 2 : 1), graphic ? -2 : -1);
      expect(used).toBeLessThanOrEqual(columns - 4);
      expect(chips[0]?.label).toBe("send");
    }
  });

  it("drops optional status segments then truncates the longest required segment", () => {
    expect(fitStatusSegments([
      { text: "very-long-model-name" }, { text: "turns", optional: true }, { text: "mode" },
    ], 12)).toEqual(["very-lo", "mode"]);
  });

  it("encodes thinking levels in the input separators", () => {
    const renderLevel = (level: "off" | "low" | "medium" | "high" | "xhigh") => {
      const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><ThinkingSeparator level={level} width={20} /></ThemeProvider>);
      const value = stripAnsi(ink.lastFrame() ?? "");
      ink.unmount();
      return value;
    };
    expect(renderLevel("off")).toBe("─".repeat(19));
    expect(renderLevel("low")).toBe("─".repeat(19));
    expect(renderLevel("medium")).toBe("═".repeat(19));
    expect(renderLevel("high")).toBe("═".repeat(19));
    expect(renderLevel("xhigh")).toBe("═".repeat(19));
  });

  it("renders status and chips without wrapping at representative 35–140 widths", () => {
    for (const width of [35, 45, 69, 70, 90, 109, 110, 140]) {
      const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><BottomBar width={width} pending spinner="⠸" mode="dev" model="claude-sonnet-4" turns={12} tokens={{ contextIn: 170_000, totalOut: 4_000, calls: 2 }} level="xhigh" workflowOn memoryFresh focusedChip={null} /></ThemeProvider>);
      const lines = stripAnsi(ink.lastFrame() ?? "").split("\n").filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(4);
      for (const line of lines) expect(terminalWidth(line)).toBeLessThanOrEqual(width - 1);
      ink.unmount();
    }
  });
});
