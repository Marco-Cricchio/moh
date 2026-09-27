/**
 * #934: the Settings Browser row.
 *
 * The row is a *state*, not a toggle: it says which project and whether the
 * user-level toolchain can launch, and enter opens the one browser setup
 * modal (never a second installer path beside the transcript warning's).
 *
 * These live in their own file because they drive a full `App` through
 * Settings into the modal — the heavier interactive flow, split from the
 * transcript-surface describes above them.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserToolchainRoot, MockProvider } from "@moh/core";
import { App } from "../src/App";
import { readBrowserSetting, writeBrowserSetting } from "../src/browser-setup";
import { COMPOSER_READY, stripAnsi, waitForFrame } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempHome = () => mkdtempSync(join(tmpdir(), "moh-browser-set-home-"));

describe("the Settings Browser row (#934)", () => {
  function appWith(project: Record<string, unknown>) {
    const cwd = mkdtempSync(join(tmpdir(), "moh-browser-set-"));
    const home = tempHome();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", ...project }));
    const i = render(
      <App intro={false} cwd={cwd} home={home} provider={MockProvider.demo()} skipOnboarding startInChat />,
    );
    return { i, cwd, home, frame: () => stripAnsi(i.lastFrame() ?? "") };
  }

  /** Opens Settings and parks the cursor on the Browser row. */
  const openSettingsOnBrowser = async (i: ReturnType<typeof render>, frame: () => string) => {
    i.stdin.write("\x13"); // ctrl+s
    await waitForFrame(frame, "settings");
    await sleep(120); // the panel commits its first paint (row 0 focused)
    // The panel starts at row 0; the Browser row sits after Moh Project Map.
    // Walk by label so an inserted row cannot silently move the target.
    const on = () => frame().split("\n").some((l) => l.includes("›") && l.includes("Browser"));
    for (let k = 0; k < 30 && !on(); k++) {
      i.stdin.write("\x1b[B");
      await sleep(40);
    }
    expect(on()).toBe(true);
  };

  test("states the project's state and the toolchain's, then opens the one setup flow", async () => {
    const { i, frame } = appWith({ browser: { enabled: true, headless: true } });
    await waitForFrame(frame, "browser");
    await openSettingsOnBrowser(i, frame);
    // The row is a state, not a toggle: which project, then the user-level
    // toolchain. The value's composition has its own unit tests
    // (`browserRowValue` / `browserToolchainLabel`, browser-warning.test);
    // the dialog truncates the tail in a test terminal.
    expect(frame()).toMatch(/Browser\s+on \(this project\)/);
    // Enter opens the same modal the transcript warning opens — one flow.
    i.stdin.write("\r");
    await waitForFrame(frame, "browser setup");
    await sleep(120); // the modal commits before the next key lands
    expect(frame()).toContain("enable the browser tool for this project");
    i.unmount();
  }, 20000);

  test("enabling from Settings writes this project's moh.json and returns to Settings", async () => {
    const { i, cwd, frame } = appWith({});
    await waitForFrame(frame, COMPOSER_READY);
    await openSettingsOnBrowser(i, frame);
    expect(frame()).toMatch(/Browser\s+off \(this project\)/);
    i.stdin.write("\r");
    await waitForFrame(frame, "browser setup");
    await sleep(120); // the modal commits before the toggle lands
    // The enabled row is the modal's first; the modal's own cursor starts
    // there, so space toggles it (the opening enter is already consumed).
    i.stdin.write(" ");
    await waitForFrame(frame, "[x] enable the browser tool for this project");
    i.stdin.write("\x1b"); // esc: apply and close
    await sleep(250);
    // The setting is durable: this project's moh.json says so, and Settings
    // came back remounted so the row states what it wrote.
    expect(JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8")).browser).toEqual({ enabled: true });
    await waitForFrame(frame, "settings");
    expect(frame()).toMatch(/Browser\s+on \(this project\)/);
    i.unmount();
  }, 20000);
});

describe("a browser change and the session it affects (#934)", () => {
  function appWith(project: Record<string, unknown>) {
    const cwd = mkdtempSync(join(tmpdir(), "moh-browser-reload-"));
    const home = tempHome();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", ...project }));
    const i = render(
      <App intro={false} cwd={cwd} home={home} provider={MockProvider.demo()} skipOnboarding startInChat />,
    );
    return { i, cwd, home, frame: () => stripAnsi(i.lastFrame() ?? "") };
  }

  /** Opens Settings on the Browser row and enables the tool for the project. */
  const enableFromSettings = async (i: ReturnType<typeof render>, frame: () => string) => {
    i.stdin.write("\x13"); // ctrl+s
    await waitForFrame(frame, "settings");
    await sleep(120);
    const on = () => frame().split("\n").some((l) => l.includes("›") && l.includes("Browser"));
    for (let k = 0; k < 30 && !on(); k++) {
      i.stdin.write("\x1b[B");
      await sleep(40);
    }
    expect(on()).toBe(true);
    i.stdin.write("\r");
    await waitForFrame(frame, "browser setup");
    await sleep(120);
    i.stdin.write(" "); // enable for this project
    await waitForFrame(frame, "[x] enable the browser tool for this project");
    i.stdin.write("\x1b"); // esc: apply and close
    await sleep(250);
  };

  test("a change with a live session re-assembles it, and says so", async () => {
    const { i, frame } = appWith({});
    await waitForFrame(frame, COMPOSER_READY);
    await enableFromSettings(i, frame);
    // The tool registers at assembly time, so the live session is rebuilt
    // through the /reload path, carrying the modal's own sentence (the
    // status bar truncates it, so match the part that identifies it; the
    // re-assembly itself is what `↻ resumed` on the transcript proves).
    await waitForFrame(frame, "browser on for");
    expect(frame()).toContain("↻ resumed");
    i.unmount();
  }, 20000);

  test("a change with no live session applies to the next one", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-browser-home-"));
    const home = tempHome();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    // No session: the App opens on Home, and Settings is reachable there.
    const i = render(<App intro={false} cwd={cwd} home={home} provider={MockProvider.demo()} skipOnboarding />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // #939: the identity gate mounts the Home tree a beat after render(),
    // so the first key waits for the settled screen.
    await waitForFrame(frame, "New session");
    await sleep(120);
    i.stdin.write("\x13"); // ctrl+s from Home
    await waitForFrame(frame, "Browser");
    i.stdin.write("\x13"); // ctrl+s from Home
    await sleep(150);
    const on = () => frame().split("\n").some((l) => l.includes("›") && l.includes("Browser"));
    for (let k = 0; k < 30 && !on(); k++) {
      i.stdin.write("\x1b[B");
      await sleep(40);
    }
    i.stdin.write("\r");
    await waitForFrame(frame, "browser setup");
    await sleep(120);
    i.stdin.write(" "); // enable
    await waitForFrame(frame, "[x] enable the browser tool for this project");
    i.stdin.write("\x1b");
    await sleep(250);
    // Durable, and the modal said which case this was: with no session to
    // re-assemble, the setting is the next session's.
    expect(JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8")).browser).toEqual({ enabled: true });
    expect(frame()).toContain("your next session");
    i.unmount();
  }, 20000);
});


describe("activation is per project (#934)", () => {
  test("enabling in one project leaves a sibling project's moh.json untouched", () => {
    // The toolchain is user-level; the *activation* is not. Two projects
    // under one home: turning the tool on in A must not touch B — that is
    // the whole reason `browser.enabled` lives in the project file.
    const home = tempHome();
    const a = mkdtempSync(join(tmpdir(), "moh-proj-a-"));
    const b = mkdtempSync(join(tmpdir(), "moh-proj-b-"));
    const bBefore = { provider: "mock", browser: { enabled: false }, mcpServers: {} };
    writeFileSync(join(a, "moh.json"), JSON.stringify({ provider: "mock" }));
    writeFileSync(join(b, "moh.json"), JSON.stringify(bBefore));

    writeBrowserSetting(a, { enabled: true });
    writeBrowserSetting(b, { enabled: false });

    expect(JSON.parse(readFileSync(join(a, "moh.json"), "utf8")).browser).toEqual({ enabled: true });
    // B is exactly what it was — not a copy of A.
    expect(JSON.parse(readFileSync(join(b, "moh.json"), "utf8"))).toEqual(bBefore);
    expect(readBrowserSetting(a).enabled).toBe(true);
    expect(readBrowserSetting(b).enabled).toBe(false);
    // And the probe's root is the home's, shared: one toolchain, two
    // projects' choices.
    expect(browserToolchainRoot(home)).toBe(join(home, ".moh", "browser-toolchain"));
  });
});
