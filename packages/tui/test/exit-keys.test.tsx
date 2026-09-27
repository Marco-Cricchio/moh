import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App";
import { MockProvider } from "@moh/core";
import { COMPOSER_READY, stripAnsi, waitForFrame } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-tui-exit-"));

const frame = (i: { lastFrame(): string | undefined }) => () => stripAnsi(i.lastFrame() ?? "");

function mount() {
  return render(
    <App intro={false} cwd={process.cwd()} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding />,
    // ink-testing-library renders with exitOnCtrlC: false — the production
    // setting — so App's own ctrl+c handler is what receives \x03 here.
  );
}

/** #939: App resolves the project identity before the tree that owns stdin
 * mounts, so a keystroke written earlier lands on nothing. */
async function mountReady() {
  const i = mount();
  await waitForFrame(frame(i), COMPOSER_READY);
  return i;
}

describe("exit is double ctrl+c (single ctrl+c disabled)", () => {
  test("first ctrl+c arms (toast), second within the window exits", async () => {
    const i = await mountReady();
    // Both presses land on an empty composer: over a draft the first press is
    // a clear instead (#1009, the describe below) — the exit sequence belongs
    // to the empty composer, so nothing is typed between the two.
    i.stdin.write("\x03"); // ctrl+c
    await waitForFrame(frame(i), "press ctrl+c again to exit");
    // Not exited yet: the toast is up and the chat is still rendering.
    await waitForFrame(frame(i), COMPOSER_READY);
    i.stdin.write("\x03");
    // The tree is frozen after exit: typed text never renders.
    i.stdin.write("gone");
    await new Promise((r) => setTimeout(r, 80));
    expect(frame(i)()).not.toContain("gone");
    i.unmount();
  });

  test("a lone ctrl+c does not exit", async () => {
    const i = await mountReady();
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

describe("#1009: a single ctrl+c clears a non-empty composer", () => {
  test("the whole draft goes in one press and ctrl+z brings it back", async () => {
    const i = await mountReady();
    i.stdin.write("a long pasted draft");
    await waitForFrame(frame(i), "a long pasted draft");
    i.stdin.write("\x03"); // ctrl+c
    await waitForFrame(frame(i), "a long pasted draft", { absent: true });
    // Clearing is not an exit press: no arm toast, and the composer is back
    // on its empty placeholder.
    expect(frame(i)()).not.toContain("press ctrl+c again to exit");
    await waitForFrame(frame(i), COMPOSER_READY);
    i.stdin.write("\x1a"); // ctrl+z — the clear is one undoable edit
    await waitForFrame(frame(i), "a long pasted draft");
    i.unmount();
  });

  test("a clear resets a standing arm: the next ctrl+c arms instead of exiting", async () => {
    const i = await mountReady();
    const armedAt = Date.now();
    i.stdin.write("\x03"); // arms on the empty composer
    await waitForFrame(frame(i), "press ctrl+c again to exit");
    i.stdin.write("draft");
    await waitForFrame(frame(i), "draft");
    i.stdin.write("\x03"); // over the draft: clears it and disarms
    await waitForFrame(frame(i), COMPOSER_READY);
    i.stdin.write("\x03");
    // The premise: this press must land inside the window the first one opened,
    // or the assertion below proves nothing.
    expect(Date.now() - armedAt).toBeLessThan(1_500);
    // Alive: an arm left standing by the clear would have exited here.
    i.stdin.write("still-alive");
    await waitForFrame(frame(i), "still-alive");
    i.unmount();
  });

  test("a whitespace-only draft counts as text: ctrl+c clears it, it does not arm", async () => {
    const i = await mountReady();
    i.stdin.write(" ");
    // Sync point: the placeholder is gone once the (invisible) draft renders.
    await waitForFrame(frame(i), COMPOSER_READY, { absent: true });
    i.stdin.write("\x03");
    await waitForFrame(frame(i), COMPOSER_READY);
    expect(frame(i)()).not.toContain("press ctrl+c again to exit");
    i.unmount();
  });
});
