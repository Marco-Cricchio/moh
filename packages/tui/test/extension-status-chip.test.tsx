/**
 * #1013: a long extension status must not hijack footer row 1. The chip's
 * text is client-supplied and unbounded upstream (the core only rejects the
 * empty string), so the bar bounds it: a capped, middle-elided chip whose
 * rendered width is reserved in the row-1 budget. What these tests pin: the
 * cap is a bounded share of the row, a self-identifying text never renders
 * the name twice, and at 160/120/90 columns the row is one physical line —
 * the gauge and the model segment intact, the long note elided.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { BottomBar, extensionStatusCap, extensionStatusText } from "../src/BottomBar";
import { stripAnsi } from "./helpers";

/** #867's real in_scope-contradiction note: 94 characters, the trigger. */
const LONG_NOTE =
  "jev-guard: exfiltration 0.88 contradicted by in_scope 0.92 — command judged in scope, passed";

function renderRow1(width: number, text: string): string[] {
  const instance = render(
    <BottomBar
      width={width}
      pending={false}
      spinner="·"
      mode="dev"
      model="opencode-go/deepseek-v4.1-flash"
      turns={3}
      tokens={{ contextIn: 41200, totalOut: 0, calls: 3 }}
      contextLimit={200000}
      level="default"
      focusedChip={null}
      extensionStatuses={[{ extension: "jev-guard", text }]}
    />,
  );
  const frame = stripAnsi(instance.lastFrame() ?? "");
  instance.unmount();
  return frame.split("\n");
}

describe("extensionStatusCap", () => {
  test("the cap is a bounded share of the row, never the whole row", () => {
    expect(extensionStatusCap(160)).toBe(50);
    expect(extensionStatusCap(120)).toBe(37);
    expect(extensionStatusCap(90)).toBe(27);
    // The floor keeps a readable fragment at the narrowest widths.
    expect(extensionStatusCap(40)).toBe(16);
    expect(extensionStatusCap(20)).toBe(16);
  });
});

describe("extensionStatusText", () => {
  test("wide: the name prefix is dropped when the text already leads with it", () => {
    const text = extensionStatusText({ extension: "jev-guard", text: "jev-guard: something happened" }, true, 50);
    expect(text).toBe("jev-guard: something happened");
  });

  test("wide: the prefix is added when the text does not identify itself", () => {
    const text = extensionStatusText({ extension: "jev-guard", text: "∅ jev offline" }, true, 50);
    expect(text).toBe("jev-guard ∅ jev offline");
  });

  test("a long note elides to the cap, keeping both ends", () => {
    const text = extensionStatusText({ extension: "jev-guard", text: LONG_NOTE }, true, 27);
    expect(text.length).toBe(27);
    expect(text.startsWith("jev-guard:")).toBe(true);
    expect(text.includes("…")).toBe(true);
  });
});

describe("row 1 with a long extension status", () => {
  for (const width of [160, 120, 90]) {
    test(`width ${width}: one physical row — gauge and model intact, note elided`, () => {
      const lines = renderRow1(width, LONG_NOTE);
      const status = lines.find((line) => line.includes("jev-guard"));
      expect(status).toBeDefined();
      // The chip elides; it never takes the width it wants.
      expect(status!.includes("…")).toBe(true);
      expect(status!.includes(LONG_NOTE.slice(0, 60))).toBe(false);
      // The context gauge is never split across lines: its `[` and `]`
      // render on the same physical line.
      const gaugeLine = lines.find((line) => line.includes("[█"));
      expect(gaugeLine).toBeDefined();
      expect(gaugeLine!.includes("]")).toBe(true);
      // The model segment never fragments mid-word.
      const modelLine = lines.find((line) => line.includes("deepseek-v4.1-flash"));
      expect(modelLine).toBeDefined();
      if (width >= 160) {
        // With room to spare the full right cluster renders on the gauge's
        // line; at 120/90 the optional counters legitimately drop.
        expect(gaugeLine!.includes("⊣ 41.2k")).toBe(true);
        expect(gaugeLine!.includes("↻ 3")).toBe(true);
      }
    });
  }

  test("width 40: the row still renders as one physical line", () => {
    const lines = renderRow1(40, LONG_NOTE);
    // #1012's compact tier: the gauge degrades to a percentage, never a
    // fragment — it stays one bracketed token on one physical line.
    const gaugeLine = lines.find((line) => /\[\d{2}%\]/.test(line) || line.includes("[█"));
    expect(gaugeLine).toBeDefined();
    expect(gaugeLine!.includes("]")).toBe(true);
  });

  test("a short status renders whole, unelided", () => {
    const lines = renderRow1(160, "∅ jev offline");
    const status = lines.find((line) => line.includes("jev offline"));
    expect(status).toBeDefined();
    expect(status!.includes("jev-guard ∅ jev offline")).toBe(true);
  });
});
