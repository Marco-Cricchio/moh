import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App";
import { MockProvider } from "@moh/core";
import { COMPOSER_READY, grantTeamExtension, pressSettled, stripAnsi, unmountSettled, waitForFrame } from "./helpers";

type View = ReturnType<typeof render>;
const frame = (i: View) => () => stripAnsi(i.lastFrame() ?? "");

/** App resolves project identity before mounting stdin (#939). Own the whole
 * lifecycle so a failed readiness/assertion cannot leak a tree or its home. */
async function withChat(work: (i: View) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "moh-tui-exit-"));
  let i: View | undefined;
  try {
    grantTeamExtension(home);
    i = render(
      <App intro={false} cwd={process.cwd()} home={home} provider={MockProvider.demo()} startInChat skipOnboarding />,
      // ink-testing-library uses exitOnCtrlC:false, as production does.
    );
    await waitForFrame(frame(i), COMPOSER_READY);
    await work(i);
  } finally {
    try {
      if (i) {
        await unmountSettled(i);
        i.cleanup();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

/** The handler compares wall-clock values; it has no arm-expiry timer.
 * Scope the clock to committed input only: readiness deadlines remain real.
 * pressSettled also flushes the composer's canClear passive effect (#1474). */
async function ctrlCAt(i: View, now: number): Promise<void> {
  const original = Date.now;
  Date.now = () => now;
  try { await pressSettled(i, "\x03"); }
  finally { Date.now = original; }
}

describe("exit is double ctrl+c (single ctrl+c disabled)", () => {
  test("first ctrl+c arms (toast), second at 1499 ms exits", async () => withChat(async (i) => {
    // Empty composer: a draft would clear instead of arming.
    await ctrlCAt(i, 10_000);
    await waitForFrame(frame(i), "press ctrl+c again to exit");
    await waitForFrame(frame(i), COMPOSER_READY);
    await ctrlCAt(i, 11_499);
    // Negative interval: the exited tree must not accept subsequent input.
    await pressSettled(i, "gone");
    await new Promise((r) => setTimeout(r, 80));
    expect(frame(i)()).not.toContain("gone");
  }));

  test("a second ctrl+c at exactly 1500 ms re-arms instead of exiting", async () => withChat(async (i) => {
    await ctrlCAt(i, 10_000);
    await waitForFrame(frame(i), "press ctrl+c again to exit");
    await ctrlCAt(i, 11_500);
    await pressSettled(i, "still-here");
    await waitForFrame(frame(i), "still-here");
  }));
});

describe("#1009: a single ctrl+c clears a non-empty composer", () => {
  test("the whole draft goes in one press and ctrl+z brings it back", async () => withChat(async (i) => {
    await pressSettled(i, "a long pasted draft");
    await waitForFrame(frame(i), "a long pasted draft");
    await ctrlCAt(i, 10_000);
    await waitForFrame(frame(i), "a long pasted draft", { absent: true });
    expect(frame(i)()).not.toContain("press ctrl+c again to exit");
    await waitForFrame(frame(i), COMPOSER_READY);
    await pressSettled(i, "\x1a");
    await waitForFrame(frame(i), "a long pasted draft");
  }));

  test("a clear resets a standing arm even inside its original window", async () => withChat(async (i) => {
    await ctrlCAt(i, 10_000);
    await waitForFrame(frame(i), "press ctrl+c again to exit");
    await pressSettled(i, "draft");
    await waitForFrame(frame(i), "draft");
    await ctrlCAt(i, 11_000); // clears and disarms
    await waitForFrame(frame(i), COMPOSER_READY);
    await ctrlCAt(i, 11_499); // would exit if the original arm survived
    await pressSettled(i, "still-alive");
    await waitForFrame(frame(i), "still-alive");
  }));

  test("a whitespace-only draft counts as text: ctrl+c clears it, it does not arm", async () => withChat(async (i) => {
    await pressSettled(i, " ");
    await waitForFrame(frame(i), COMPOSER_READY, { absent: true });
    await ctrlCAt(i, 10_000);
    await waitForFrame(frame(i), COMPOSER_READY);
    expect(frame(i)()).not.toContain("press ctrl+c again to exit");
  }));
});
