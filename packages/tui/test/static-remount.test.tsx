import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const provider = MockProvider.scripted([
      { deltas: ["SETTLEDMARKER turn done"], finish: "stop" },
    ]);
    const i = render(<App cwd={cwd} home={home} provider={provider} skipOnboarding />);
    await sleep(50);
    i.stdin.write("hello");
    await sleep(150);
    i.stdin.write("\r");
    await sleep(300);
    for (let n = 0; n < 3; n++) {
      i.stdin.write("\x13"); // ctrl+s → settings
      await sleep(150);
      i.stdin.write("\x1b"); // esc → close
      await sleep(150);
    }
    const output = i.lastFrame() ?? "";
    const count = output.split("SETTLEDMARKER").length - 1;
    console.log(`[regression] marker appears ${count}x in last frame`);
    expect(count).toBe(1);
    i.unmount();
  }, 15000);
});
