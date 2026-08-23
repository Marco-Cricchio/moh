import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { Dashboard, MENU_ENTRIES, fitChips } from "../src/Dashboard";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

/** Forces the viewport hook's terminal size (ink-testing-library has no size option). */
function atSize(columns: number, rows: number, ui: React.ReactNode) {
  const i = render(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{ui}</ThemeProvider>);
  Object.defineProperty(i.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(i.stdout, "rows", { value: rows, configurable: true });
  i.rerender(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{ui}</ThemeProvider>);
  return i;
}

describe("chip row budget", () => {
  test("at 90 cols all six chips fit; on narrow widths the least-essential drop first", () => {
    const chips: [string, string][] = [
      ["⏎", "send"],
      ["esc", "steer"],
      ["^s", "settings"],
      ["^k", "commands"],
      ["^m", "mode"],
      ["^t", "theme"],
    ];
    expect(fitChips(chips, 90).length).toBe(6);
    const at80 = fitChips(chips, 80);
    expect(at80.length).toBeLessThan(6);
    expect(at80[0]).toEqual(["⏎", "send"]);
    expect(fitChips(chips, 10)).toEqual([]);
  });
});

describe("dashboard frame (issue #115)", () => {
  test("renders menu entries, right-sidebar placeholder and chip footer around the center", () => {
    const i = atSize(
      100,
      30,
      <Dashboard mode="dev" modelLabel="mock">
        <Box flexGrow={1}>
          <Text>center placeholder</Text>
        </Box>
      </Dashboard>,
    );
    const frame = stripAnsi(i.lastFrame() ?? "");
    for (const entry of MENU_ENTRIES) expect(frame).toContain(entry);
    expect(frame).toContain("center placeholder");
    expect(frame).toContain("mock · dev");
    for (const chip of ["send", "steer", "settings", "commands", "mode", "theme"]) {
      expect(frame).toContain(chip);
    }
    i.unmount();
  });

  test("the rendered frame never exceeds the terminal row budget", () => {
    for (const [columns, rows] of [[90, 24], [100, 30], [140, 45], [200, 60]] as const) {
      const i = atSize(
        columns,
        rows,
        <Dashboard mode="vibe" modelLabel="m">
          <Box flexGrow={1}>
            <Text>x</Text>
          </Box>
        </Dashboard>,
      );
      const lines = stripAnsi(i.lastFrame() ?? "").split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBeLessThanOrEqual(rows);
      i.unmount();
    }
  });
});
