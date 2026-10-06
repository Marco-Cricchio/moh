/**
 * #1132 (ADR-0062): the extensions rail and the extension overlay, as the
 * TUI renders them. What these tests pin: the rail is absent by default
 * (the UI is unchanged for anyone without extensions), a panel renders with
 * its declared max-height, an extension that throws contributes one visible
 * failure line instead of crashing the session, the narrow-terminal form is
 * a footer strip rather than the zone, and a full-screen overlay opens
 * through ExtensionOverlayView and closes on Esc.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { ExtensionOverlayView, ExtensionsRail } from "../src/ExtensionsRail";
import { RAIL_MIN_ROWS } from "../src/rail-layout";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

type Panel = Parameters<typeof ExtensionsRail>[0]["panels"][number];

const ROWS = 24; // comfortably above the rail's tiny-terminal floor

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    extension: "ops",
    name: "status",
    description: "deployment status",
    render: () => React.createElement(Text, null, "all green"),
    ...overrides,
  };
}

function mount(node: React.ReactElement) {
  const instance = render(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{node}</ThemeProvider>);
  return {
    instance,
    frame: () => stripAnsi(instance.lastFrame() ?? ""),
    unmount: () => instance.unmount(),
  };
}

describe("ExtensionsRail (#1132)", () => {
  test("with no panels the rail contributes nothing at all", () => {
    const i = mount(<ExtensionsRail panels={[]} collapsed={new Set()} columns={120} rows={ROWS} />);
    expect(i.frame().trim()).toBe("");
    i.unmount();
  });

  test("every panel collapsed renders nothing — the zone disappears", () => {
    const i = mount(<ExtensionsRail panels={[panel()]} collapsed={new Set(["status"])} columns={120} rows={ROWS} />);
    expect(i.frame().trim()).toBe("");
    i.unmount();
  });

  test("wide: the client-drawn header shows identity and the real allocation", async () => {
    const i = mount(<ExtensionsRail panels={[panel({ maxHeight: 6 })]} collapsed={new Set()} columns={120} rows={ROWS} />);
    await new Promise((r) => setTimeout(r, 30)); // the demand measurement settles
    const frame = i.frame();
    expect(frame).toContain("status");
    expect(frame).toContain("ops");
    // The allocation is real: a 1-row body in a bordered box of 24 available rows.
    expect(frame).toContain("·1r (8%)");
    // The declaration is not shown — allocation, not declaration (#1218).
    expect(frame).not.toContain("max 6");
    // The extension's own Ink output is drawn untouched in the panel.
    expect(frame).toContain("all green");
    i.unmount();
  });

  test("wide: a declared maxHeight that cuts the demand is marked as clamped", async () => {
    const lines = (n: number) =>
      React.createElement(
        React.Fragment,
        null,
        Array.from({ length: n }, (_, i) => React.createElement(Text, { key: i }, `row ${i}`)),
      );
    const i = mount(
      <ExtensionsRail
        panels={[panel({ name: "logs", maxHeight: 4, render: () => lines(30) })]}
        collapsed={new Set()}
        columns={120}
        rows={ROWS}
      />,
    );
    await new Promise((r) => setTimeout(r, 30)); // the demand measurement settles
    const frame = i.frame();
    expect(frame).toContain("·max 4 → 4");
    expect(frame).toContain("max 4");
    i.unmount();
  });

  test("an extension whose render throws yields one visible failure line, not a crash", async () => {
    const i = mount(
      <ExtensionsRail
        panels={[
          panel({ name: "boom", render: () => { throw new Error("extension bug"); } }),
          panel({ name: "fine", render: () => React.createElement(Text, null, "ok") }),
        ]}
        collapsed={new Set()}
        columns={120}
        rows={ROWS}
      />,
    );
    await new Promise((r) => setTimeout(r, 30)); // the throw + demand settle into the stable frame
    const frame = i.frame();
    expect(frame).toContain("panel failed to render");
    expect(frame).toContain("fine"); // its neighbour still renders
    i.unmount();
  });

  test("narrow: the rail collapses to a footer strip naming the panels", () => {
    const i = mount(<ExtensionsRail panels={[panel()]} collapsed={new Set()} columns={60} rows={ROWS} />);
    const frame = i.frame().trim();
    // One line, naming the panel — never the declared column zone.
    expect(frame.split("\n")).toHaveLength(1);
    expect(frame).toContain("status");
    i.unmount();
  });

  test("a collapsed panel is absent from the narrow strip too", () => {
    const i = mount(
      <ExtensionsRail panels={[panel(), panel({ name: "other" })]} collapsed={new Set(["other"])} columns={60} rows={ROWS} />,
    );
    const frame = i.frame();
    expect(frame).toContain("status");
    expect(frame).not.toContain("other");
    i.unmount();
  });
});

describe("ExtensionOverlayView (#1132)", () => {
  test("renders the extension's overlay full-screen, named, with its esc hint", () => {
    let closed = 0;
    const i = mount(
      <ExtensionOverlayView
        overlay={{ extension: "ops", name: "console", render: () => React.createElement(Text, null, "console body") }}
        onClose={() => { closed += 1; }}
      />,
    );
    const frame = i.frame();
    expect(frame).toContain("console");
    expect(frame).toContain("ops");
    expect(frame).toContain("esc");
    expect(frame).toContain("console body");
    i.unmount();
    expect(closed).toBe(0);
  });

  test("Esc closes it (the client's own close seam is what runs)", async () => {
    let closed = 0;
    const i = mount(
      <ExtensionOverlayView
        overlay={{ extension: "ops", name: "console", render: () => React.createElement(Text, null, "console body") }}
        onClose={() => { closed += 1; }}
      />,
    );
    i.instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 30));
    i.unmount();
    expect(closed).toBe(1);
  });
});
