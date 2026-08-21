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
const tempHome = () => mkdtempSync(join(tmpdir(), "moh-app-ov-"));

describe("App overlays (issue #33)", () => {
  test("first run with nothing configured opens onboarding; skip lands on home", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const home = tempHome();
    const i = render(<App cwd={cwd} home={home} />);
    await sleep(50);
    // Either the env-detect list or the wizard — never the home screen.
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("connect a provider");
    i.stdin.write("s"); // skip (works in both phases)
    await sleep(50);
    i.stdin.write("n"); // skip the workflow offer revealed by correct overlay layering
    await sleep(50);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("search or start something new");
    i.unmount();
  });

  test("a configured provider skips onboarding entirely", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("search or start something new");
    i.unmount();
  });

  test("? opens the all-commands panel, esc closes; s opens settings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    i.stdin.write("?");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Home");
    i.stdin.write("\x1b"); // esc closes
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("all commands");
    i.stdin.write("s"); // settings from home
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("settings");
    i.stdin.write("\x1b");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("Default permission mode");
    i.unmount();
  });

  test("ctrl+s and ctrl+k open the panels from home too", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    i.stdin.write("\x13"); // ctrl+s
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("settings");
    i.stdin.write("\x1b");
    await sleep(30);
    i.stdin.write("\x0b"); // ctrl+k
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Home");
    i.unmount();
  });

  test("in chat, ? on an empty draft opens commands, then closes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    i.stdin.write("n"); // new session → chat
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("type…");
    i.stdin.write("?");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Home");
    i.stdin.write("\x1b");
    await sleep(50);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("all commands");
    expect(frame).toContain("type…"); // chat still alive under the closed overlay
    i.unmount();
  });
});
