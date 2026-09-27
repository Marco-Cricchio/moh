import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { loadUserConfig } from "../src/user-config";
import { COMPOSER_READY, stripAnsi, waitForCondition, waitForFrame } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-settings-live-"));

describe("settings changes apply live (#196)", () => {
  test("toggling mode in the settings panel flips the session label immediately", async () => {
    const provider = MockProvider.demo();
    const home = tempHome();
    const i = render(<App intro={false} cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // #939: the identity gate mounts the tree — and its input handlers — a
    // beat after render(), so the first keystroke waits for the settled chat.
    await waitForFrame(frame, "○ vibe");
    await new Promise((r) => setTimeout(r, 120));
    i.stdin.write("\x13"); // ctrl+s → settings
    await waitForFrame(frame, "settings");
    await new Promise((r) => setTimeout(r, 200)); // let the panel's useInput attach
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
    const i = render(<App intro={false} cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // A painted frame can precede useInput's passive effect. Flush the
    // input update before the next key, without sleeping or replaying it.
    const send = async (key: string) => {
      const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previous = env.IS_REACT_ACT_ENVIRONMENT;
      env.IS_REACT_ACT_ENVIRONMENT = true;
      try {
        await act(async () => { i.stdin.write(key); });
      } finally {
        if (previous === undefined) delete env.IS_REACT_ACT_ENVIRONMENT;
        else env.IS_REACT_ACT_ENVIRONMENT = previous;
      }
    };
    try {
      await waitForFrame(frame, COMPOSER_READY);
      await send("draft"); // a draft in the input proves the remount below
      await waitForFrame(frame, "draft");
      await send("\x13"); // ctrl+s → settings
      await waitForFrame(frame, "› Mode");
      await send("\x1b[B"); // down → Theme row
      await waitForFrame(frame, "› Theme");
      await send("\r"); // activate → opens the theme picker
      await waitForFrame(frame, "› Tokyo Night [s]");
      await send("\x1b[B"); // catppuccin (built-ins in catalog order)
      await waitForFrame(frame, "› Catppuccin Mocha");
      await send("\r"); // apply catppuccin
      // The label also exists in the open picker: persistence and the
      // picker closing, not merely its label, acknowledge the application.
      await waitForCondition(
        () => loadUserConfig(join(home, ".moh", "config")).theme === "catppuccin",
        () => `theme was not applied. Last frame:\n${frame()}`,
      );
      await waitForFrame(frame, "› Catppuccin Mocha", { absent: true });
      await waitForFrame(frame, "Catppuccin Mocha");
      await send("\x1b"); // close
      // The remount clears the volatile input draft — with the bug
      // (persist-only) the draft survives and no color changes.
      await waitForFrame(frame, "Default permission mode", { absent: true });
      await waitForFrame(frame, COMPOSER_READY);
      expect(frame()).not.toContain("draft");
      expect(loadUserConfig(join(home, ".moh", "config")).theme).toBe("catppuccin");
    } finally {
      i.unmount();
    }
  });
});
