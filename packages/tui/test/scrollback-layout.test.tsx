import { describe, expect, it } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { fitRow } from "../src/viewport";
import { BottomBar, ThinkingSeparator, fitStatusSegments, visibleChips, widthClass183 } from "../src/BottomBar";
import { ThemeProvider, THEMES } from "../src/themes";
import { stripAnsi } from "./helpers";
import { transcriptTail } from "../src/Chat";
import type { TranscriptBlock } from "../src/transcript";

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
  it("replays the newest complete transcript blocks within the modal budget", () => {
    const blocks: TranscriptBlock[] = ["one", "two", "three", "four"].map((type, i) => ({
      key: String(i), kind: "moh", glyph: "◆", type, lines: [type],
    }));
    // #950 calibration: a block occupies body + 3 rows (top margin, head,
    // trailing gap), so a 6-row budget keeps only one 1-line block.
    expect(transcriptTail(blocks, 100, 8).map((block) => block.type)).toEqual(["three", "four"]);
    expect(transcriptTail(blocks, 100, 6).map((block) => block.type)).toEqual(["four"]);
  });

  it("clips an oversized single live block to the row budget (#201)", () => {
    const text = `BEGIN-${"x".repeat(500)}-END`;
    const blocks: TranscriptBlock[] = [{
      key: "oversized", kind: "moh", glyph: "◆", type: "moh",
      lines: [text], markdown: text,
    }];
    const tail = transcriptTail(blocks, 20, 5);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.lines.join("\n")).toContain("-END");
    expect(tail[0]!.lines.join("\n")).not.toContain("BEGIN-");
    // The terminal Markdown renderer consumes markdown rather than lines;
    // its live tail must be clipped too (#201).
    expect(tail[0]!.markdown).not.toContain("BEGIN-");
    // One available character must still clip; String#slice(-0) would
    // otherwise return the entire line.
    expect(transcriptTail(blocks, 4, 3)[0]!.lines).toEqual(["…"]);
  });

  it("bounds row-chunk blocks by their rendered height and clips their rows (#950)", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `row ${i}`);
    const blocks: TranscriptBlock[] = [
      { key: "p", kind: "moh", glyph: "◆", type: "moh", lines: [], renderedMarkdownRows: rows },
      { key: "q", kind: "moh", glyph: "◆", type: "moh", lines: ["tail"] },
    ];
    // A 60-row live Markdown chunk must count as 60 rows against a budget of
    // 10, not as the 2 rows the line-wrap estimate computes for empty lines.
    // The oversized block is newest, so the single-block escape clips it.
    const tail = transcriptTail([blocks[1]!, blocks[0]!], 20, 10);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.key).toBe("p");
    expect(tail[0]!.renderedMarkdownRows).toBeDefined();
    expect(tail[0]!.renderedMarkdownRows!.length).toBeLessThan(rows.length);
    expect(tail[0]!.renderedMarkdownRows!.at(-1)).toBe("row 59");
    // Budget 10 minus head/margins/gap = 7 body rows: the oldest rows are
    // gone.
    expect(tail[0]!.renderedMarkdownRows![0]).toBe("row 53");
    // The whole-block escape still keeps the newest rows in the tail.
    expect(tail[0]!.renderedMarkdownRows!.length).toBeLessThanOrEqual(8);
    // A settled row-chunk block under the budget passes through untouched.
    expect(transcriptTail(blocks, 20, 100).map((b) => b.key)).toEqual(["p", "q"]);
    // An older row-chunk block that does not fit is dropped, not miscounted.
    expect(transcriptTail(blocks, 20, 10).map((b) => b.key)).toEqual(["q"]);
  });

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
    expect(renderLevel("medium")).toBe("─".repeat(19));
    expect(renderLevel("high")).toBe("─".repeat(19));
    expect(renderLevel("xhigh")).toBe("─".repeat(19));
  });

  it("hides token/turn numbers in vibe, keeps the context bar and dev metrics (#193, #229)", () => {
    const props = { width: 120, pending: false, spinner: "⠸", model: "claude-sonnet-4", turns: 12, tokens: { contextIn: 170_000, totalOut: 4_000, calls: 2 }, level: "medium" as const, workflowOn: true, memoryFresh: true, focusedChip: null };
    const renderBar = (mode: "vibe" | "dev") => {
      const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><BottomBar {...props} mode={mode} /></ThemeProvider>);
      const value = stripAnsi(ink.lastFrame() ?? "");
      ink.unmount();
      return value;
    };
    expect(renderBar("vibe")).not.toContain("⊣");
    expect(renderBar("vibe")).not.toContain("↻ 12");
    expect(renderBar("vibe")).toContain("█"); // the wordless context bar renders in vibe too (#228)
    expect(renderBar("vibe")).toContain("○ vibe");
    expect(renderBar("dev")).toContain("↻ 12");
    expect(renderBar("dev")).toContain("◉ dev");
  });

  it("renders status and chips without wrapping at representative 35–140 widths", () => {
    for (const width of [35, 45, 69, 70, 90, 109, 110, 140]) {
      const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><BottomBar width={width} pending spinner="⠸" mode="dev" model="claude-sonnet-4" turns={12} tokens={{ contextIn: 170_000, totalOut: 4_000, calls: 2 }} level="xhigh" workflowOn memoryFresh cwd="/Users/mc/Documents/AI_Projects/moh" branch="develop" permissionMode="yolo" focusedChip={null} /></ThemeProvider>);
      const lines = stripAnsi(ink.lastFrame() ?? "").split("\n").filter(Boolean);
      // 2A status layout: state row + where-you-are row (cwd/branch/mode) + chips.
      expect(lines.length).toBeLessThanOrEqual(5);
      for (const line of lines) expect(terminalWidth(line)).toBeLessThanOrEqual(width - 1);
      ink.unmount();
    }
  });
});
