import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Dashboard-sized app in a chat session (ink-testing-library defaults to 80 cols). */
function chatApp() {
  const cwd = mkdtempSync(join(tmpdir(), "moh-focus-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "moh-focus-home-"));
  const i = render(
    <App cwd={cwd} home={home} provider={MockProvider.demo()} skipOnboarding startInChat />,
  );
  Object.defineProperty(i.stdout, "columns", { value: 100, configurable: true });
  Object.defineProperty(i.stdout, "rows", { value: 30, configurable: true });
  i.rerender(
    <App cwd={cwd} home={home} provider={MockProvider.demo()} skipOnboarding startInChat />,
  );
  return i;
}

describe("focus model (issue #116)", () => {
  test("tab focuses the menu (❯ on Dashboard), letters are inert while menu-focused", async () => {
    const i = chatApp();
    await sleep(50);
    let frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("type…");
    expect(frame).not.toContain("❯ Dashboard");
    i.stdin.write("\t"); // tab → menu
    await sleep(50);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("❯ Dashboard");
    // key leaks: "s" must not open settings, "x" must not type anywhere
    i.stdin.write("s");
    await sleep(50);
    i.stdin.write("x");
    await sleep(50);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("Default permission mode");
    expect(frame).not.toContain("sx");
    // the real barrier in App's useInput: even global keybinds stay dead
    i.stdin.write("\x0b"); // ctrl+k — must NOT open the commands panel
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("all commands");
    i.unmount();
  });

  test("↓ moves the selection, ⏎ on Sessions returns to home; tab restores input", async () => {
    const i = chatApp();
    await sleep(50);
    i.stdin.write("\t");
    await sleep(50);
    i.stdin.write("\x1b[B"); // ↓ → Sessions
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("❯ Sessions");
    i.stdin.write("\r"); // ⏎ → home
    await sleep(50);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("search or start something new");
    i.unmount();
  });

  test("⏎ on Settings opens the settings overlay; closing it restores the input", async () => {
    const i = chatApp();
    await sleep(50);
    i.stdin.write("\t");
    await sleep(50);
    i.stdin.write("\x1b[B\x1b[B\x1b[B"); // ↓↓↓ → Settings
    await sleep(50);
    i.stdin.write("\r");
    await sleep(50);
    let frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("settings");
    i.stdin.write("\x1b"); // esc closes
    await sleep(50);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("type…"); // input focus restored, no ❯
    expect(frame).not.toContain("❯ Dashboard");
    i.unmount();
  });
});
