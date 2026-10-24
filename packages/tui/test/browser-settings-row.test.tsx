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
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserToolchainRoot, MockProvider } from "@moh/core";
import { App } from "../src/App";
import { readBrowserSetting, writeBrowserSetting } from "../src/browser-setup";
import { COMPOSER_READY, grantTeamExtension, pressCommitted, stripAnsi, waitStep, waitText } from "./helpers";

type View = ReturnType<typeof render>;

/**
 * Parks the cursor on the Settings Browser row of an open Settings panel.
 * Walks by label so an inserted row cannot silently move the target; each
 * step waits for the commit that carries its key (#1473), never a sleep.
 */
const walkToBrowserRow = async (i: View, frame: () => string) => {
  const on = () => frame().split("\n").some((l) => l.includes("›") && l.includes("Browser"));
  for (let k = 0; k < 30 && !on(); k++) await pressCommitted(i, "\x1b[B", "the cursor moved down a row");
  expect(on()).toBe(true);
};

/** Enter on the Browser row, then space on the modal's first row (enable). */
const enableInModal = async (i: View) => {
  i.stdin.write("\r");
  await waitText(i, "browser setup", "the browser setup modal opened");
  i.stdin.write(" "); // the modal's cursor starts on the enable row
  await waitText(i, "[x] enable the browser tool for this project", "the enable row toggled on");
};
const tempHome = () => { const h = mkdtempSync(join(tmpdir(), "moh-browser-set-home-")); grantTeamExtension(h); return h; };

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
  const openSettingsOnBrowser = async (i: View, frame: () => string) => {
    i.stdin.write("\x13"); // ctrl+s
    await waitText(i, "settings", "Settings opened");
    await walkToBrowserRow(i, frame);
  };

  test("states the project's state and the toolchain's, then opens the one setup flow", async () => {
    const { i, frame } = appWith({ browser: { enabled: true, headless: true } });
    await waitText(i, "browser", "the app rendered");
    await openSettingsOnBrowser(i, frame);
    // The row is a state, not a toggle: which project, then the user-level
    // toolchain. The value's composition has its own unit tests
    // (`browserRowValue` / `browserToolchainLabel`, browser-warning.test);
    // the dialog truncates the tail in a test terminal.
    expect(frame()).toMatch(/Browser\s+on \(this project\)/);
    // Enter opens the same modal the transcript warning opens — one flow.
    i.stdin.write("\r");
    await waitText(i, "browser setup", "the browser setup modal opened");
    await waitText(i, "enable the browser tool for this project", "the modal's enable row painted");
    expect(frame()).toContain("enable the browser tool for this project");
    i.unmount();
  }, 20000);

  test("enabling from Settings writes this project's moh.json and returns to Settings", async () => {
    const { i, cwd, frame } = appWith({});
    await waitText(i, COMPOSER_READY, "the composer mounted");
    await openSettingsOnBrowser(i, frame);
    expect(frame()).toMatch(/Browser\s+off \(this project\)/);
    // The enable row is the modal's first; its cursor starts there.
    await enableInModal(i);
    i.stdin.write("\x1b"); // esc: apply and close
    // The setting is durable: this project's moh.json says so, and Settings
    // came back remounted so the row states what it wrote.
    await waitStep(i, () => JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8")).browser?.enabled === true, "moh.json written");
    expect(JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8")).browser).toEqual({ enabled: true });
    await waitText(i, "settings", "Settings came back");
    await waitStep(i, () => /Browser\s+on \(this project\)/.test(frame()), "the row states what was written");
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
  const enableFromSettings = async (i: View, frame: () => string) => {
    i.stdin.write("\x13"); // ctrl+s
    await waitText(i, "settings", "Settings opened");
    await walkToBrowserRow(i, frame);
    await enableInModal(i);
    i.stdin.write("\x1b"); // esc: apply and close
  };

  test("a change with a live session re-assembles it, and says so", async () => {
    const { i, frame } = appWith({});
    await waitText(i, COMPOSER_READY, "the composer mounted");
    await enableFromSettings(i, frame);
    // The tool registers at assembly time, so the live session is rebuilt
    // through the /reload path, carrying the modal's own sentence (the
    // status bar truncates it, so match the part that identifies it; the
    // re-assembly itself is what `↻ resumed` on the transcript proves).
    await waitText(i, "browser on for", "the modal named the change");
    await waitText(i, "↻ resumed", "the session re-assembled");
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
    await waitText(i, "New session", "Home settled");
    i.stdin.write("\x13"); // ctrl+s from Home
    await waitText(i, "Browser", "Settings opened from Home");
    await walkToBrowserRow(i, frame);
    await enableInModal(i);
    i.stdin.write("\x1b");
    await waitText(i, "your next session", "the modal said which case this was");
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
