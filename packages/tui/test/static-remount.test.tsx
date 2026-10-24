import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { COMPOSER_READY, grantTeamExtension, useFileCredentialStore, waitText } from "./helpers";

// #1504: no test here may read the login keychain (a synchronous `security`
// spawn at mount stalled the fixed sleeps this file used to wait on).
useFileCredentialStore();

/** A sentinel only the settings dialog renders (its title is a common word). */
const SETTINGS_OPEN = "Default permission mode";

/**
 * Regression (live session 20260825T141305096Z): every modal cycle
 * (alternate screen in/out) unmounted <Static>, resetting ink's printed-
 * items counter — on close the whole settled transcript was reprinted to
 * the main buffer. The first turn appeared once per opened modal.
 *
 * Seam: a full App with a completed turn, then N modal open/close cycles;
 * the settled marker must be emitted to the output stream exactly once.
 */
describe("settled transcript survives modal cycles (Static remount regression)", () => {
  test("settings open/close x3 does not reprint settled turns", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    grantTeamExtension(home); // the team consent modal must not ride the cycles
    const provider = MockProvider.scripted([
      { deltas: ["SETTLEDMARKER turn done"], finish: "stop" },
    ]);
    const i = render(<App intro={false} cwd={cwd} home={home} provider={provider} skipOnboarding />);
    await waitText(i, "New session", "the home screen");
    i.stdin.write("hello");
    await waitText(i, "start “hello”", "the new-session row");
    i.stdin.write("\r");
    await waitText(i, "SETTLEDMARKER", "the settled turn");
    await waitText(i, COMPOSER_READY, "the composer idle again");
    for (let n = 0; n < 3; n++) {
      i.stdin.write("\x13"); // ctrl+s → settings
      await waitText(i, SETTINGS_OPEN, `settings open (cycle ${n + 1})`);
      i.stdin.write("\x1b"); // esc → close
      await waitText(i, SETTINGS_OPEN, `settings closed (cycle ${n + 1})`, { absent: true });
    }
    const output = i.lastFrame() ?? "";
    const count = output.split("SETTLEDMARKER").length - 1;
    console.log(`[regression] marker appears ${count}x in last frame`);
    expect(count).toBe(1);
    i.unmount();
  }, 15000);
});
