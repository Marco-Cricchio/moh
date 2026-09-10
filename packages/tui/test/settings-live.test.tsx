import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { loadUserConfig } from "../src/user-config";
import { stripAnsi, waitForFrame } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-settings-live-"));

describe("settings changes apply live (#196)", () => {
  test("toggling mode in the settings panel flips the session label immediately", async () => {
    const provider = MockProvider.demo();
    const home = tempHome();
    const i = render(<App cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitForFrame(frame, "○ vibe");
    i.stdin.write("\x13"); // ctrl+s → settings
    await waitForFrame(frame, "settings");
    await new Promise((r) => setTimeout(r, 60)); // let the panel's useInput attach
    i.stdin.write("\r"); // activate the Mode row → dev
    await waitForFrame(frame, "│   › Mode                      dev ");
    i.stdin.write("\x1b"); // close
    await waitForFrame(frame, "◉ dev");
    expect(frame()).toContain("◉ dev");
    expect(loadUserConfig(join(home, ".moh", "config")).mode).toBe("dev");
    i.unmount();
  });

  test("changing theme in the settings panel remounts with the new theme", async () => {
    const provider = MockProvider.demo();
    const home = tempHome();
    const i = render(<App cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitForFrame(frame, "type…");
    i.stdin.write("draft"); // a draft in the input proves the remount below
    await waitForFrame(frame, "draft");
    i.stdin.write("\x13"); // ctrl+s → settings
    await waitForFrame(frame, "settings");
    await new Promise((r) => setTimeout(r, 60)); // let the panel's useInput attach
    i.stdin.write("\x1b[B"); // down → Theme row
    await new Promise((r) => setTimeout(r, 20));
    i.stdin.write("\r"); // activate → next theme (catppuccin)
    await waitForFrame(frame, "Catppuccin Mocha", { timeoutMs: 3_000 });
    i.stdin.write("\x1b"); // close
    // The remount clears the volatile input draft — with the bug
    // (persist-only) the draft survives and no color changes.
    await waitForFrame(frame, "type…");
    const final = frame();
    expect(final).not.toContain("draft");
    expect(loadUserConfig(join(home, ".moh", "config")).theme).toBe("catppuccin");
    i.unmount();
  });
});
