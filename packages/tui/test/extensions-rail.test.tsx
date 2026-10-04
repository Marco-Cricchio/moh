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
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

type Panel = Parameters<typeof ExtensionsRail>[0]["panels"][number];

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
    const i = mount(<ExtensionsRail panels={[]} collapsed={new Set()} columns={120} />);
    expect(i.frame().trim()).toBe("");
    i.unmount();
  });

  test("every panel collapsed renders nothing — the zone disappears", () => {
    const i = mount(<ExtensionsRail panels={[panel()]} collapsed={new Set(["status"])} columns={120} />);
    expect(i.frame().trim()).toBe("");
    i.unmount();
  });

  test("wide: the panel name, its extension, the declared max-height and its own rendering are shown", () => {
    const i = mount(<ExtensionsRail panels={[panel({ maxHeight: 6 })]} collapsed={new Set()} columns={120} />);
    const frame = i.frame();
    expect(frame).toContain("status");
    expect(frame).toContain("ops");
    expect(frame).toContain("max 6");
    // The extension's own Ink output is drawn untouched in the zone.
    expect(frame).toContain("all green");
    i.unmount();
  });

  test("an extension whose render throws yields one visible failure line, not a crash", () => {
    const i = mount(
      <ExtensionsRail
        panels={[
          panel({ name: "boom", render: () => { throw new Error("extension bug"); } }),
          panel({ name: "fine", render: () => React.createElement(Text, null, "ok") }),
        ]}
        collapsed={new Set()}
        columns={120}
      />,
    );
    const frame = i.frame();
    expect(frame).toContain("panel failed to render");
    expect(frame).toContain("fine"); // its neighbour still renders
    i.unmount();
  });

  test("narrow: the rail collapses to a footer strip naming the panels", () => {
    const i = mount(<ExtensionsRail panels={[panel()]} collapsed={new Set()} columns={60} />);
    const frame = i.frame().trim();
    // One line, naming the panel — never the declared column zone.
    expect(frame.split("\n")).toHaveLength(1);
    expect(frame).toContain("status");
    i.unmount();
  });

  test("a collapsed panel is absent from the narrow strip too", () => {
    const i = mount(
      <ExtensionsRail panels={[panel(), panel({ name: "other" })]} collapsed={new Set(["other"])} columns={60} />,
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
