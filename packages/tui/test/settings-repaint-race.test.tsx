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
 * #330: toggling Provider reasoning in the Settings overlay arms a
 * whole-transcript repaint that stays pending while the modal owns the
 * alternate screen. On close it must fire only after the alternate→main
 * buffer flip completes — firing concurrently makes the re-emitted Static
 * blocks land in the dying alternate buffer, leaving the chat blank in a
 * real terminal (recovery only via /mode).
 *
 * Seam: a full App with a settled turn, exercised through the Settings
 * overlay (ctrl+s → navigate → enter → esc). The ink-testing-library
 * output stream cannot emulate real terminal buffers, so the regression
 * is asserted on write ordering: the post-close reprint of the settled
 * marker must come after the "\x1b[?1049l" buffer-flip write.
 */
describe("deferred transcript repaint vs alternate-screen close (#330)", () => {
  test("the post-close reprint happens after the buffer flip", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const provider = MockProvider.scripted([
      { reasoning: { deltas: ["HISTMARKER historical reasoning"] }, deltas: ["ANSWERMARKER turn done"], finish: "stop" },
    ]);
    const i = render(<App cwd={cwd} home={home} provider={provider} startInChat skipOnboarding />);
    // The alternate-screen choreography is TTY-gated; the harness stdout
    // reports as non-TTY unless marked here.
    Object.defineProperty(i.stdout, "isTTY", { value: true });
    await sleep(50);
    i.stdin.write("hello");
    await sleep(150);
    i.stdin.write("\r");
    await sleep(300);
    expect((i.frames.at(-1) ?? "").includes("ANSWERMARKER")).toBe(true);

    // Settings → Provider reasoning row → toggle (default hide → show).
    i.stdin.write("\x13"); // ctrl+s
    await sleep(150);
    for (let n = 0; n < 11; n++) {
      i.stdin.write("\x1b[B"); // down to the "Provider reasoning" row
      await sleep(20);
    }
    i.stdin.write("\r"); // toggle show
    await sleep(150);
    const frameBefore = i.frames.at(-1) ?? "";
    expect(frameBefore).toContain("show");
    const escAt = i.frames.length;
    i.stdin.write("\x1b"); // esc → close (arms the deferred repaint)
    await sleep(200); // outlast the flip delay (40ms) + throttle

    // The flip back to the main buffer must be written by the close
    // choreography (TTY path active in the harness).
    const frames = i.frames;
    const flipIndex = frames.reduce((last, frame, index) => (frame.includes("\x1b[?1049l") ? index : last), -1);
    expect(flipIndex).toBeGreaterThanOrEqual(0);

    // The pending whole-transcript repaint starts with a deterministic
    // clear-screen + scrollback write; it must fire only after the buffer
    // flip completes (with the bug it races the 40ms flip timer and its
    // Static re-emission lands in the dying alternate buffer).
    const clearIndex = frames.reduce((last, frame, index) => (index > escAt && frame.includes("\x1b[3J") ? index : last), -1);
    expect(clearIndex).toBeGreaterThan(flipIndex);

    // And the transcript is re-emitted under the new setting after the
    // flip — visible in the main buffer, not lost in the alternate one.
    const reprintIndex = frames.findIndex((frame, index) => index > flipIndex && frame.includes("ANSWERMARKER"));
    expect(reprintIndex).toBeGreaterThan(flipIndex);
    i.unmount();
  }, 15000);
});
