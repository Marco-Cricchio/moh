import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { userConfigFile } from "../src/user-config";

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
    for (let n = 0; n < 13; n++) {
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

  test("show→hide: the repaint drops historical reasoning and still fires after the flip", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    // Start with display on so the toggle direction is show→hide.
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(userConfigFile(home), JSON.stringify({ showReasoning: true }));
    const provider = MockProvider.scripted([
      { reasoning: { deltas: ["HISTMARKER historical reasoning"] }, deltas: ["ANSWERMARKER turn done"], finish: "stop" },
    ]);
    const i = render(<App cwd={cwd} home={home} provider={provider} startInChat skipOnboarding />);
    Object.defineProperty(i.stdout, "isTTY", { value: true });
    await sleep(50);
    i.stdin.write("hello");
    await sleep(150);
    i.stdin.write("\r");
    await sleep(300);

    i.stdin.write("\x13"); // ctrl+s
    await sleep(150);
    for (let n = 0; n < 13; n++) {
      i.stdin.write("\x1b[B");
      await sleep(20);
    }
    i.stdin.write("\r"); // toggle hide
    await sleep(150);
    const escAt = i.frames.length;
    i.stdin.write("\x1b"); // esc → close
    await sleep(200);

    const frames = i.frames;
    const flipIndex = frames.reduce((last, frame, index) => (frame.includes("\x1b[?1049l") ? index : last), -1);
    expect(flipIndex).toBeGreaterThanOrEqual(0);
    const clearIndex = frames.reduce((last, frame, index) => (index > escAt && frame.includes("\x1b[3J") ? index : last), -1);
    expect(clearIndex).toBeGreaterThan(flipIndex);
    const reprintIndex = frames.findIndex((frame, index) => index > flipIndex && frame.includes("ANSWERMARKER"));
    expect(reprintIndex).toBeGreaterThan(flipIndex);
    // NOTE: the harness accumulates Static output and cannot emulate the
    // real clear-screen escape, so "reasoning gone" is not observable
    // here — that drop is asserted at the Chat seam in
    // reasoning-controls.test.tsx (#242).
    i.unmount();
  }, 15000);

  test("rapid close→reopen cancels the flip without reprinting into the modal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const provider = MockProvider.scripted([
      { reasoning: { deltas: ["HISTMARKER historical reasoning"] }, deltas: ["ANSWERMARKER turn done"], finish: "stop" },
    ]);
    const i = render(<App cwd={cwd} home={home} provider={provider} startInChat skipOnboarding />);
    Object.defineProperty(i.stdout, "isTTY", { value: true });
    await sleep(50);
    i.stdin.write("hello");
    await sleep(150);
    i.stdin.write("\r");
    await sleep(300);

    i.stdin.write("\x13"); // ctrl+s
    await sleep(150);
    for (let n = 0; n < 13; n++) {
      i.stdin.write("\x1b[B");
      await sleep(20);
    }
    i.stdin.write("\r"); // toggle show → arms the deferred repaint
    await sleep(150);
    i.stdin.write("\x1b"); // esc → close, flip timer armed
    await sleep(10); // still inside the 40ms flip window (scheduling may
    // still let the timer win — the invariant below tolerates both)
    i.stdin.write("\x13"); // ctrl+s → reopen, cancels any pending flip
    await sleep(150);
    i.stdin.write("\x1b"); // final close
    await sleep(250);

    // Invariant: a whole-transcript repaint clear (2J/3J) is never
    // written while the alternate buffer is active — track buffer state
    // from the flip escapes and check every clear write lands in the
    // main buffer, whatever the close→reopen interleaving turned out to
    // be. The final repaint must still follow the last flip.
    const frames = i.frames;
    let inAlternate = false;
    let lastFlipIndex = -1;
    frames.forEach((frame, index) => {
      if (frame.includes("\x1b[?1049h")) inAlternate = true;
      if (frame.includes("\x1b[?1049l")) { inAlternate = false; lastFlipIndex = index; }
      if (frame.includes("\x1b[3J")) {
        expect(inAlternate).toBe(false);
        expect(index).toBeGreaterThan(lastFlipIndex);
      }
    });
    expect(lastFlipIndex).toBeGreaterThanOrEqual(0);
    const reprintIndex = frames.findIndex((frame, index) => index > lastFlipIndex && frame.includes("ANSWERMARKER"));
    expect(reprintIndex).toBeGreaterThan(lastFlipIndex);
    i.unmount();
  }, 15000);
});
