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
import { createRequire } from "node:module";
const chalk = createRequire(import.meta.resolve("ink"))("chalk").default as { level: 0 | 1 | 2 | 3 };
import { beforeEach, afterEach } from "bun:test";
let previousColorLevel: typeof chalk.level;
beforeEach(() => { previousColorLevel = chalk.level; chalk.level = 3; });
afterEach(() => { chalk.level = previousColorLevel; });
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntime, MockProvider, createSession } from "@moh/core";
import { createTeamExtension, teamManifestAuthority } from "@moh/team";
import { App } from "../src/App";
import { ExtensionOverlayView, ExtensionsRail } from "../src/ExtensionsRail";
import type { PanelKeyEvent } from "@moh/extension";
import { RAIL_MIN_ROWS } from "../src/rail-layout";
import { GROW_VERTICAL_FRAMES } from "../src/icons";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { grantTeamExtension, stripAnsi, waitForCondition } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  test("#1300: a string roster's selected row animates a running glyph and keeps the semantic colors", async () => {
    const roster = ["team: 2 members", ">◐ alpha · running", " ✓ beta · done", " ◐ gamma · running"].join("\n");
    const mountRaw = (frame: number) => {
      const i = render(
        <ThemeProvider value={THEMES[DEFAULT_THEME]}>
          <ExtensionsRail
            panels={[panel({ name: "team", render: () => roster })]}
            collapsed={new Set()}
            columns={120}
            rows={ROWS}
            frame={frame}
          />
        </ThemeProvider>,
      );
      return i;
    };
    const a = mountRaw(0);
    await new Promise((r) => setTimeout(r, 30));
    const frameA = stripAnsi(a.lastFrame() ?? "");
    expect(frameA).toContain(GROW_VERTICAL_FRAMES[0]!);
    expect(frameA).toContain("alpha · running");
    expect(frameA).toContain(`${GROW_VERTICAL_FRAMES[0]} gamma · running`);
    expect(a.lastFrame() ?? "").toContain("\u001b[38;2;46;160;67m✓");
    a.unmount();
    const b = mountRaw(4);
    await new Promise((r) => setTimeout(r, 30));
    const frameB = b.lastFrame() ?? "";
    expect(stripAnsi(frameB)).toContain(GROW_VERTICAL_FRAMES[4]!);
    b.unmount();
    // A settled member on the selected row takes the fixed semantic green,
    // not the theme token (tokyo-night's ok is #9ece6a).
    const settled = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <ExtensionsRail
          panels={[panel({ name: "team", render: () => ["team: 1 member", ">✓ beta · done"].join("\n") })]}
          collapsed={new Set()}
          columns={120}
          rows={ROWS}
          frame={2}
        />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 30));
    // With truecolor forced, the settled glyph carries the fixed semantic
    // green, not the theme token (tokyo-night's ok is #9ece6a).
    expect(settled.lastFrame() ?? "").toContain("\u001b[38;2;46;160;67m✓");
    const frameS = stripAnsi(settled.lastFrame() ?? "");
    expect(frameS).toContain("✓ beta · done");
    for (const glyph of GROW_VERTICAL_FRAMES) expect(frameS).not.toContain(`${glyph} beta`);
    settled.unmount();
  });

  test("#1300: only the recognized running glyph animates — the row text stays verbatim", async () => {
    const roster = ["team: 1 member", ">⏸ alpha · stalled"].join("\n");
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <ExtensionsRail panels={[panel({ name: "team", render: () => roster })]} collapsed={new Set()} columns={120} rows={ROWS} frame={7} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 30));
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("⏸ alpha · stalled");
    // the ⏸ never swaps for a frame glyph
    for (const glyph of GROW_VERTICAL_FRAMES) expect(frame).not.toContain(`${glyph} alpha`);
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

describe("rail auto-open on the first panels (owner directive, pre-main)", () => {
  const tempHome = () => { const h = mkdtempSync(join(tmpdir(), "moh-rail-auto-")); grantTeamExtension(h); return h; };
  const tempDir = () => mkdtempSync(join(tmpdir(), "moh-rail-auto-cwd-"));

  /** A real session with the bundled team mounted and pre-consented; the
   * lead's scripted turn composes a team through the team tool, so the
   * panel appears with no user action at all. */
  async function composedTeamSession() {
    const rt = new ExtensionRuntime({ mohHome: tempHome(), consent: () => true });
    expect(await rt.register(createTeamExtension(), { manifest: teamManifestAuthority() })).toBe(true);
    await rt.ready();
    const session = createSession({
      provider: MockProvider.scripted([
        {
          deltas: ["composing the team"],
          finish: "tool_calls",
          toolCalls: [{ name: "team", args: { compose: [{ role: "builder", name: "builder-1", task: "write one line" }] } }],
        },
        { deltas: ["the team is on it"], finish: "stop" },
      ]),
      extensions: rt,
      permissions: { unrestrictedTools: true },
      subagents: {
        home: tempDir(),
        provider: MockProvider.scripted([{ deltas: ["child answer"], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } }]),
      },
    });
    return session;
  }

  test("a composed team opens the rail with no keystroke — and an un-composed team does not", async () => {
    const session = await composedTeamSession();
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <App intro={false} cwd={tempDir()} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding session={session} />
      </ThemeProvider>,
    );
    Object.defineProperty(i.stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(i.stdout, "rows", { value: 30, configurable: true });
    i.stdout.emit("resize");
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      // Before any send: the panel is mounted but the team does not exist
      // yet — the rail stays closed (an empty roster must not flash open
      // on every session that merely loads the extension).
      await sleep(150);
      expect(frame()).not.toContain("team: ");
      void session.send("work with the team");
      // No `/extensions`, no `r`, no Ctrl+P: the composition alone opens
      // the rail — "team: 1 member" exists only in the panel's roster
      // head, never in the chat transcript.
      await waitForCondition(
        () => frame().includes("team: 1 member"),
        () => "the team panel to be visible with no user toggle",
        { timeoutMs: 8000 },
      );
      await waitForCondition(() => frame().includes("team team") && frame().includes("team: 1 member"), () => frame());
      const lines = frame().split("\n");
      const header = lines.findIndex((line) => line.includes("team team"));
      const roster = lines.findIndex((line) => line.includes("team: 1 member"));
      const composer = lines.findIndex((line) => line.includes("shift+enter"));
      expect(header).toBeGreaterThanOrEqual(1);
      expect(lines[header]!.indexOf("team team")).toBeGreaterThan(60);
      expect(roster).toBeLessThan(composer);
      expect(lines.slice(header - 1, composer).some((line) => line.slice(0, 60).trim().length > 0)).toBe(true);
      i.stdin.write("\x10");
      await sleep(40);
      i.stdin.write("\x1b");
      await sleep(40);
      i.stdin.write("esc-returned-draft");
      await waitForCondition(() => frame().includes("esc-returned-draft"), frame);
      i.stdin.write("\x10");
      await sleep(40);
      Object.defineProperty(i.stdout, "rows", { value: 18, configurable: true });
      i.stdout.emit("resize");
      await sleep(80);
      i.stdin.write("short-height-draft");
      await waitForCondition(() => frame().includes("short-height-draft"), frame);
      expect(frame()).not.toContain("team team");
      i.unmount();
      await session.dispose();
    } catch (error) {
      i.unmount();
      await session.dispose();
      throw error;
    }
  }, 20000);
});
