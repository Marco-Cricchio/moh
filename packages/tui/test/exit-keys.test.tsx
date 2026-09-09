import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App";
import { MockProvider } from "@moh/core";
import { stripAnsi, waitForFrame } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-tui-exit-"));

const frame = (i: { lastFrame(): string | undefined }) => () => stripAnsi(i.lastFrame() ?? "");

function mount() {
  return render(
    <App cwd={process.cwd()} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding />,
    // ink-testing-library renders with exitOnCtrlC: false — the production
    // setting — so App's own ctrl+c handler is what receives \x03 here.
  );
}

describe("exit is double ctrl+c (single ctrl+c disabled)", () => {
  test("first ctrl+c arms (toast), second within the window exits", async () => {
    const i = mount();
    i.stdin.write("\x03"); // ctrl+c
    await waitForFrame(frame(i), "press ctrl+c again to exit");
    i.stdin.write("still-alive");
    // Not exited yet: the toast stays and typing still renders.
    await waitForFrame(frame(i), "still-alive");
    i.stdin.write("\x03");
    // The tree is frozen after exit: typed text never renders.
    i.stdin.write("gone");
    await new Promise((r) => setTimeout(r, 80));
    expect(frame(i)()).not.toContain("gone");
    i.unmount();
  });

  test("a lone ctrl+c does not exit", async () => {
    const i = mount();
    i.stdin.write("\x03");
    await waitForFrame(frame(i), "press ctrl+c again to exit");
    // Wait past the 1.5s arm window (the toast itself lives 3.5s —
    // Toasts.TOAST_MS — so its disappearance is not the signal; the
    // second press landing after the window is).
    await new Promise((r) => setTimeout(r, 1_600));
    i.stdin.write("\x03");
    i.stdin.write("still-here");
    await waitForFrame(frame(i), "still-here");
    i.unmount();
  });
});
