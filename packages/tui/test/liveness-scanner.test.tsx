/**
 * #876 / ADR-0042: the liveness scanner on the bottom bar's first row.
 *
 * While a turn is live, row 1's left slot is a seven-cell scanner sweep — one
 * lit segment walking left→right and back, a decaying trail behind it, the
 * unlit track visible the whole time — in place of the generic braille cycle.
 *
 * What these tests pin: the geometry (ping-pong with no wrap, exactly one
 * light, the trail on the cells just passed), the glyph family and its ASCII
 * fallback, that the beat never repeats a frame within a cycle (a live turn
 * always looks alive), that the strip fits every width class without wrapping,
 * and that the frame still travels the `spinner` seam as one plain string —
 * the older braille frame included, which must keep rendering.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { BottomBar } from "../src/BottomBar";
import { setIcons } from "../src/icons";
import { SCANNER_CELLS, scannerFrame, scannerGlyph, scannerPosition, scannerRole, scannerSweep } from "../src/scanner";
import { ThemeProvider, THEMES } from "../src/themes";
import { App } from "../src/App";
import { stripAnsi, waitForCondition } from "./helpers";

afterEach(() => setIcons(true));

describe("the sweep geometry (#876, ADR-0042)", () => {
  test("ping-pong: one cell per tick, reversing at both ends, never wrapping", () => {
    const seen = Array.from({ length: 2 * SCANNER_CELLS }, (_, tick) => scannerPosition(tick, SCANNER_CELLS));
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 0, 1]);
    for (let tick = 0; tick < 200; tick++) {
      const here = scannerPosition(tick, SCANNER_CELLS);
      const next = scannerPosition(tick + 1, SCANNER_CELLS);
      expect(Math.abs(next - here)).toBe(1);
      expect(here).toBeGreaterThanOrEqual(0);
      expect(here).toBeLessThan(SCANNER_CELLS);
    }
  });

  test("one frame: exactly one light, the trail on the cells it just passed, track elsewhere", () => {
    for (let tick = 0; tick < 24; tick++) {
      const sweep = scannerSweep(tick, SCANNER_CELLS);
      expect(sweep).toHaveLength(SCANNER_CELLS);
      expect(sweep.filter((distance) => distance === 0)).toHaveLength(1);
      expect(sweep.indexOf(0)).toBe(scannerPosition(tick, SCANNER_CELLS));
      // The trail dims with distance and never outnumbers the light's past.
      const trail = sweep.filter((distance) => distance === 1 || distance === 2);
      expect(trail.length).toBeGreaterThanOrEqual(1);
      expect(trail.length).toBeLessThanOrEqual(2);
      for (const distance of sweep) expect(distance).toBeGreaterThanOrEqual(0);
    }
  });

  test("the light is always where the previous frames left it: the trail follows the walk", () => {
    // At tick 4 the light sits on cell 4; the cells it passed are 3 then 2.
    expect(scannerSweep(4, 7)).toEqual([3, 3, 2, 1, 0, 3, 3]);
    // Reversing at the right end: the light turned on cell 5 having passed 6.
    expect(scannerSweep(7, 7)).toEqual([3, 3, 3, 3, 3, 0, 1]);
  });

  test("the beat never repeats a frame within a cycle: a live turn always looks alive", () => {
    const period = 2 * SCANNER_CELLS - 2; // 12 ticks: 7 out, 5 back
    const cycle = Array.from({ length: period }, (_, tick) => scannerFrame(tick, SCANNER_CELLS));
    // Every tick of a cycle is a distinct picture, and the picture recurs only
    // after the light has completed the whole round trip.
    expect(new Set(cycle).size).toBe(period);
    expect(scannerFrame(period)).toBe(cycle[0]!);
    expect(scannerPosition(period * 7 + 5, SCANNER_CELLS)).toBe(scannerPosition(5, SCANNER_CELLS));
  });
});

describe("the glyph family (#876, ADR-0042)", () => {
  test("seven cells of vertical rectangles: a lit segment, a fading trail, a track", () => {
    const frame = scannerFrame(0);
    expect(Array.from(frame)).toHaveLength(7);
    expect(frame).toBe("▮▯▫····");
    expect(scannerFrame(3)).toBe("·▫▯▮···");
    // The intensity is carried by the glyph, so the strip reads in monochrome.
    expect([...new Set(Array.from(scannerFrame(0)))].sort()).toEqual(["·", "▫", "▯", "▮"].sort());
  });

  test("an icon-free terminal gets the ASCII strip, same geometry", () => {
    setIcons(false);
    expect(scannerFrame(0)).toBe("#=-....");
    expect(scannerFrame(3)).toBe(".-=#...");
    expect(scannerGlyph(0)).toBe("#");
    expect(scannerGlyph(3)).toBe(".");
  });

  test("the bar colours each cell by the role its glyph means, both families", () => {
    expect(scannerRole("▮")).toBe("head");
    expect(scannerRole("▯")).toBe("trail");
    expect(scannerRole("▫")).toBe("trail");
    expect(scannerRole("·")).toBe("track");
    expect(scannerRole("#")).toBe("head");
    expect(scannerRole("=")).toBe("trail");
    expect(scannerRole("-")).toBe("trail");
    expect(scannerRole(".")).toBe("track");
    // Anything that is not part of the strip is not claimed: the older braille
    // frame and the phase word keep the slot's own colour.
    expect(scannerRole("⠸")).toBeNull();
    expect(scannerRole("t")).toBeNull();
  });
});

describe("the scanner in row 1 (#876, ADR-0042)", () => {
  const base = { pending: true, model: "claude-sonnet-4", turns: 12, tokens: { contextIn: 0, totalOut: 0, calls: 0 }, level: "default" as const, focusedChip: null, mode: "dev" as const, phase: "thinking" };

  const renderBar = (props: Record<string, unknown>) => {
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><BottomBar {...(base as any)} {...(props as any)} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    ink.unmount();
    return frame;
  };

  test("the strip renders in the pending left slot, with the phase word beside it", () => {
    const row = renderBar({ width: 120, spinner: scannerFrame(0) }).split("\n")[0]!;
    expect(row.trimStart().startsWith("▮▯▫···· thinking")).toBe(true);
  });

  test("below 70 columns the phase word goes and the strip stays", () => {
    for (const width of [35, 50, 69]) {
      const row = renderBar({ width, spinner: scannerFrame(3) }).split("\n")[0]!;
      expect(row).toContain("·▫▯▮···");
      expect(row).not.toContain("thinking");
    }
  });

  test("never wraps from 35 to 140 columns, whatever the strip is showing", () => {
    for (const width of [35, 45, 69, 70, 90, 109, 110, 120, 140]) {
      for (const tick of [0, 3, 6]) {
        const frame = renderBar({ width, spinner: scannerFrame(tick) });
        const row = frame.split("\n")[0]!;
        expect(row).toContain("▮");
        for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(width - 1);
      }
    }
  });

  test("a caller passing the older braille frame still renders (the seam is unchanged)", () => {
    const row = renderBar({ width: 120, spinner: "⠸" }).split("\n")[0]!;
    expect(row).toContain("⠸ thinking");
  });
});

describe("the live beat on a real session (#876, ADR-0042)", () => {
  test("a live turn shows the sweep, and the sweep advances", async () => {
    // Slow deltas keep the turn pending long enough to see the beat move.
    const provider = MockProvider.scripted([{ deltas: ["one ", "two ", "three ", "four ", "five"], deltaDelayMs: 120, finish: "stop" }]);
    const home = mkdtempSync(join(tmpdir(), "moh-876-scan-home-"));
    const i = render(<App cwd={mkdtempSync(join(tmpdir(), "moh-876-scan-cwd-"))} home={home} provider={provider} startInChat skipOnboarding />);
    const frameText = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForCondition(() => frameText().includes("ready"), () => "chat never opened");
      await i.stdin.write("go");
      // The composer takes the text on its own commit: a bare Enter in the
      // same chunk is swallowed (harness timing, not product behavior).
      await new Promise((resolve) => setTimeout(resolve, 30));
      await i.stdin.write("\r");
      // The strip is the left slot of row 1 while pending.
      await waitForCondition(() => /[▮▯▫·]{7} thinking/.test(frameText()), () => "the scanner strip never rendered");
      const first = /[▮▯▫·]{7}/.exec(frameText())![0];
      await waitForCondition(() => /[▮▯▫·]{7}/.exec(frameText())?.[0] !== first, () => "the sweep never advanced");
    } finally {
      i.unmount();
    }
  });
});
