/**
 * ScrollDialog (vertical-overflow guarantee): a dialog body taller than
 * the terminal never overflows it — the rows window inside the viewport
 * with more-indicators, and the frame never exceeds the terminal height.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { ScrollDialog } from "../src/ui";
import { stripAnsi } from "./helpers";

function frameOf(children: React.ReactNode): string {
  const instance = render(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{children}</ThemeProvider>);
  const frame = stripAnsi(instance.lastFrame() ?? "");
  instance.unmount();
  return frame;
}

describe("ScrollDialog", () => {
  const manyRows = Array.from({ length: 40 }, (_, i) => ({
    node: <Text key={i}>{` row ${i}`}</Text>,
    weight: 1,
  }));

  test("a body taller than the viewport is windowed, never overflowing", () => {
    // ink-testing-library's fake stdout has no rows → the 24-row fallback.
    const frame = frameOf(<ScrollDialog title=" test " rows={manyRows} />);
    const lines = frame.split("\n");
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(frame).toContain("↓ 23 more (↑↓ scroll)");
    // First rows visible, later rows not.
    expect(frame).toContain("row 0");
    expect(frame).not.toContain("row 39");
  });

  test("a body that fits renders whole, with no indicators", () => {
    const few = manyRows.slice(0, 3);
    const frame = frameOf(<ScrollDialog title=" test " rows={few} footer={<Text> footer</Text>} />);
    expect(frame).toContain("row 0");
    expect(frame).toContain("row 2");
    expect(frame).toContain("footer");
    expect(frame).not.toContain("more (↑↓ scroll)");
  });

  test("fixed header and footer stay outside the window", () => {
    const frame = frameOf(
      <ScrollDialog
        title=" test "
        rows={manyRows}
        header={<Text> header line</Text>}
        footer={<Text> footer line</Text>}
      />,
    );
    expect(frame).toContain("header line");
    expect(frame).toContain("footer line");
  });
});
