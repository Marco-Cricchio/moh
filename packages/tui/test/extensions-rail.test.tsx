/**
 * #1132 (ADR-0062): the extensions rail and the extension overlay, as the
 * TUI renders them. What these tests pin: the rail is absent by default
 * (the UI is unchanged for anyone without extensions), a panel renders with
 * its declared max-height, an extension that throws contributes one visible
 * failure line instead of crashing the session, the narrow-terminal form is
 * a footer strip rather than the zone, and a full-screen overlay opens
 * through ExtensionOverlayView and closes on Esc. #1225: in focus mode the
 * client forwards the keys it does not consume to the focused panel's
 * onKey, and a consumed key costs the panel one re-render.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { ExtensionOverlayView, ExtensionsRail } from "../src/ExtensionsRail";
import type { PanelKeyEvent } from "@moh/extension";
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

describe("focused keys → the panel's onKey (#1225)", () => {
  function keysPanel(seen: { input: string; key: PanelKeyEvent }[]) {
    return {
      extension: "ops",
      name: "keys",
      description: "key seam",
      maxHeight: 6,
      render: () => React.createElement(Text, null, `seen ${seen.length}`),
      onKey: (input: string, key: PanelKeyEvent) => {
        seen.push({ input, key });
        return true;
      },
    };
  }

  test("in focus mode a non-client key reaches onKey and a consumed key re-renders", async () => {
    const seen: { input: string; key: PanelKeyEvent }[] = [];
    const i = mount(<ExtensionsRail panels={[keysPanel(seen)]} collapsed={new Set()} columns={120} rows={ROWS} focused />);
    await new Promise((r) => setTimeout(r, 30));
    expect(i.frame()).toContain("seen 0");
    i.instance.stdin.write("x");
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.map((s) => s.input)).toEqual(["x"]);
    expect(seen[0]!.key.return).toBeUndefined();
    expect(i.frame()).toContain("seen 1"); // the consumed key cost one re-render
    i.unmount();
  });

  test("esc stays the client's: the panel never sees it and focus exits", async () => {
    const seen: { input: string; key: PanelKeyEvent }[] = [];
    let exited = 0;
    const i = mount(
      <ExtensionsRail
        panels={[keysPanel(seen)]}
        collapsed={new Set()}
        columns={120}
        rows={ROWS}
        focused
        onFocusExit={() => {
          exited += 1;
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    i.instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
    expect(exited).toBe(1);
    i.unmount();
  });

  test("tab cycles panels, never reaches onKey; j scrolls when the panel ignores it (#1226 precedence)", async () => {
    const seen: { input: string; key: PanelKeyEvent }[] = [];
    const lines = (n: number) =>
      React.createElement(React.Fragment, null, Array.from({ length: n }, (_, k) => React.createElement(Text, { key: k }, `line ${k}`)));
    const scrollPanel: Panel = {
      extension: "ops",
      name: "tall",
      description: "",
      render: () => lines(20),
      onKey: (input, key) => {
        seen.push({ input, key });
        return false; // the panel ignores keys: j/k stay the scroll fallback
      },
    };
    const i = mount(
      <ExtensionsRail
        panels={[scrollPanel, panel({ name: "second" })]}
        collapsed={new Set()}
        columns={120}
        rows={ROWS}
        focused
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    i.instance.stdin.write("j"); // the panel ignores it — the client scrolls
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.map((s) => s.input)).toEqual(["j"]); // forwarded first (#1226)
    expect(i.frame()).toContain("↑1"); // the position indicator tracks the window
    i.instance.stdin.write("\t"); // cycles to "second" — client-owned
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.map((s) => s.input)).toEqual(["j"]);
    i.unmount();
  });

  test("a composing panel consumes j/k: the draft letters win over the scroll (#1226)", async () => {
    const seen: string[] = [];
    const composing: Panel = {
      extension: "ops",
      name: "compose",
      description: "",
      maxHeight: 6,
      render: () => React.createElement(Text, null, `draft ${seen.join("")}`),
      onKey: (input) => {
        seen.push(input);
        return true;
      },
    };
    const i = mount(<ExtensionsRail panels={[composing]} collapsed={new Set()} columns={120} rows={ROWS} focused />);
    await new Promise((r) => setTimeout(r, 30));
    i.instance.stdin.write("j");
    await new Promise((r) => setTimeout(r, 30));
    i.instance.stdin.write("k");
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["j", "k"]); // no scroll: the panel consumed both
    expect(i.frame()).toContain("draft jk");
    i.unmount();
  });

  test("a throwing onKey costs the session nothing — the key is swallowed, the rail keeps rendering", async () => {
    let exited = 0;
    const boom: Panel = {
      extension: "ops",
      name: "boom",
      description: "",
      render: () => React.createElement(Text, null, "alive"),
      onKey: () => {
        throw new Error("extension bug");
      },
    };
    const i = mount(
      <ExtensionsRail
        panels={[boom]}
        collapsed={new Set()}
        columns={120}
        rows={ROWS}
        focused
        onFocusExit={() => {
          exited += 1;
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    i.instance.stdin.write("x");
    await new Promise((r) => setTimeout(r, 30));
    expect(i.frame()).toContain("alive");
    i.instance.stdin.write("y");
    await new Promise((r) => setTimeout(r, 30));
    expect(i.frame()).toContain("alive"); // the input loop survived the second throw
    i.instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 30));
    expect(exited).toBe(1);
    i.unmount();
  });

  test("a panel without onKey stays purely read-only — keys are simply ignored", async () => {
    let exited = 0;
    const i = mount(
      <ExtensionsRail
        panels={[panel()]}
        collapsed={new Set()}
        columns={120}
        rows={ROWS}
        focused
        onFocusExit={() => {
          exited += 1;
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    i.instance.stdin.write("x");
    await new Promise((r) => setTimeout(r, 30));
    expect(i.frame()).toContain("all green");
    expect(exited).toBe(0);
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
