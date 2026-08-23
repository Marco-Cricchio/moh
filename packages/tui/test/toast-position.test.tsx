import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { Dashboard } from "../src/Dashboard";
import { Toasts, useToasts, type Toast } from "../src/Toasts";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

function atSize(columns: number, rows: number, ui: React.ReactNode) {
  const i = render(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{ui}</ThemeProvider>);
  Object.defineProperty(i.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(i.stdout, "rows", { value: rows, configurable: true });
  i.rerender(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{ui}</ThemeProvider>);
  return i;
}

/** leading column of the (single) line containing `needle` */
function columnOf(frame: string, needle: string): number {
  const line = stripAnsi(frame).split("\n").find((l) => l.includes(needle));
  if (!line) throw new Error(`no line with ${needle}`);
  return line.indexOf(needle);
}

describe("toast position (issue #119)", () => {
  test("push stores an optional position; default is chat", async () => {
    let api!: ReturnType<typeof useToasts>;
    function Harness() {
      api = useToasts();
      React.useEffect(() => {
        api.push("memory updated · work", "ok", "side");
        api.push("theme: dos");
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <Toasts toasts={api.toasts} />;
    }
    const i = render(<Harness />);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.toasts[0]).toMatchObject({ text: "memory updated · work", position: "side" });
    expect(api.toasts[1]!.position).toBe("chat");
    i.unmount();
  });

  test("dashboard renders side toasts in the left sidebar and chat toasts centered over the chat area", () => {
    const toasts: Toast[] = [
      { id: 1, text: "mem updated", kind: "ok", position: "side" },
      { id: 2, text: "permission granted", kind: "ok" },
    ];
    const i = atSize(
      100,
      30,
      <Dashboard modelLabel="m" toasts={toasts}>
        <Box flexGrow={1}>
          <Text>chat</Text>
        </Box>
      </Dashboard>,
    );
    const frame = i.lastFrame() ?? "";
    expect(stripAnsi(frame)).toContain("mem updated");
    expect(stripAnsi(frame)).toContain("permission granted");
    // side toast lives inside the ~20-col menu sidebar; chat toast sits well past it
    expect(columnOf(frame, "mem updated")).toBeLessThan(20);
    expect(columnOf(frame, "permission granted")).toBeGreaterThan(25);
    i.unmount();
  });

  test("a long side toast wraps to the sidebar width instead of spilling into the chat column", () => {
    const long = "memory updated · " + "topic ".repeat(8);
    const toasts: Toast[] = [{ id: 1, text: long, kind: "ok", position: "side" }];
    const i = atSize(
      100,
      30,
      <Dashboard modelLabel="m" toasts={toasts}>
        <Box flexGrow={1}>
          <Text>chat</Text>
        </Box>
      </Dashboard>,
    );
    for (const line of stripAnsi(i.lastFrame() ?? "").split("\n")) {
      if (line.includes("memory") || line.includes("topic")) {
        expect(line.length - line.trimStart().length).toBeLessThan(20);
        expect(line.trimEnd().length).toBeLessThanOrEqual(21);
      }
    }
    i.unmount();
  });

  test("Toasts without a dashboard renders inline centered as before", () => {
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <Toasts toasts={[{ id: 1, text: "saved settings", kind: "info" }]} />
      </ThemeProvider>,
    );
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("saved settings");
    i.unmount();
  });
});
