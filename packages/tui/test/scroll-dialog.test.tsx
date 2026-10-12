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

async function frameOf(children: React.ReactNode): Promise<string> {
  const instance = render(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{children}</ThemeProvider>);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const frame = stripAnsi(instance.lastFrame() ?? "");
  instance.unmount();
  return frame;
}

describe("ScrollDialog", () => {
  const manyRows = Array.from({ length: 40 }, (_, i) => ({
    node: <Text key={i}>{` row ${i}`}</Text>,
    weight: 1,
  }));

  test("a body taller than the viewport is windowed, never overflowing", async () => {
    // ink-testing-library's fake stdout has no rows → the 24-row fallback.
    const frame = await frameOf(<ScrollDialog title=" test " rows={manyRows} />);
    const lines = frame.split("\n");
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(frame).toContain("╭");
    expect(frame).toContain("╮");
    expect(frame).toContain("╰");
    expect(frame).toContain("╯");
    expect(frame).toContain("↓ 24 more (↑↓ scroll)");
    // First rows visible, later rows not.
    expect(frame).toContain("row 0");
    expect(frame).not.toContain("row 39");
  });

  test("a body that fits renders whole, with no indicators", async () => {
    const few = manyRows.slice(0, 3);
    const frame = await frameOf(<ScrollDialog title=" test " rows={few} footer={<Text> footer</Text>} />);
    expect(frame).toContain("row 0");
    expect(frame).toContain("row 2");
    expect(frame).toContain("footer");
    expect(frame).not.toContain("more (↑↓ scroll)");
  });

  test("fixed header and footer stay outside the window", async () => {
    const frame = await frameOf(
      <ScrollDialog
        title=" test "
        rows={manyRows}
        header={<Text>{" header line\nsecond header line"}</Text>}
        footer={<><Text> footer line</Text><Text>second footer line</Text></>}
      />,
    );
    expect(frame).toContain("header line");
    expect(frame).toContain("footer line");
    expect(frame).toContain("second header line");
    expect(frame).toContain("second footer line");
    expect(frame).toContain("╭");
    expect(frame).toContain("╰");
    expect(frame.split("\n").length).toBeLessThanOrEqual(23);
  });
});
