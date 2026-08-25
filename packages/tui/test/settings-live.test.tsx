import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { loadUserConfig } from "../src/user-config";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempHome = () => mkdtempSync(join(tmpdir(), "moh-settings-live-"));

describe("settings changes apply live (#196)", () => {
  test("toggling mode in the settings panel flips the session label immediately", async () => {
    const provider = MockProvider.demo();
    const home = tempHome();
    const i = render(<App cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("○ vibe");
    i.stdin.write("\x13"); // ctrl+s → settings
    await sleep(150);
    i.stdin.write("\r"); // activate the Mode row → dev
    await sleep(150);
    i.stdin.write("\x1b"); // close
    await sleep(150);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("◉ dev");
    expect(loadUserConfig(join(home, ".moh", "config")).mode).toBe("dev");
    i.unmount();
  });

  test("changing theme in the settings panel remounts with the new theme", async () => {
    const provider = MockProvider.demo();
    const home = tempHome();
    const i = render(<App cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />);
    await sleep(30);
    i.stdin.write("draft"); // a draft in the input proves the remount below
    await sleep(50);
    i.stdin.write("\x13"); // ctrl+s → settings
    await sleep(150);
    i.stdin.write("\x1b[B"); // down → Theme row
    await sleep(100);
    i.stdin.write("\r"); // activate → next theme (catppuccin)
    await sleep(200);
    i.stdin.write("\x1b"); // close
    await sleep(300);
    // themeTick remount clears the volatile input draft — with the bug
    // (persist-only) the draft survives and no color changes.
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("draft");
    expect(frame).toContain("type…");
    expect(loadUserConfig(join(home, ".moh", "config")).theme).toBe("catppuccin");
    i.unmount();
  });
});
