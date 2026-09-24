import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { stripAnsi, waitForCondition, waitForFrame } from "./helpers";

/** #201: the mode switch repaints the visible transcript in the new
 * grammar instead of only affecting future turns. */
describe("mode switch repaints the transcript (#201)", () => {
  test("a turn settled in vibe re-renders in dev grammar after the switch", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["answer one"], finish: "stop", usage: { inputTokens: 100, outputTokens: 10 } },
      { deltas: ["answer two"], finish: "stop", usage: { inputTokens: 200, outputTokens: 20 } },
    ]);
    const i = render(
      <App intro={false} cwd={process.cwd()} home={mkdtempSync(join(tmpdir(), "moh-rep-"))} provider={provider} startInChat skipOnboarding />,
    );
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // Settled turns promote through Static and leave the volatile frame,
    // so assertions read the accumulated frames (continuity.tui pattern).
    const seen = (text: string) => i.frames.some((f) => stripAnsi(f).includes(text));

    // #939: the identity gate mounts the tree (and its input handlers) a
    // beat after render(); wait for the settled chat before the first key.
    await waitForFrame(frame, "type…");
    await new Promise((r) => setTimeout(r, 120));
    i.stdin.write("one");
    await new Promise((r) => setTimeout(r, 20));
    i.stdin.write("\r");
    await waitForCondition(() => seen("answer one"), () => "first turn reply never appeared");
    expect(i.frames.some((f) => stripAnsi(f).includes("100 in"))).toBe(false);

    i.stdin.write("\x0f"); // ctrl+o → dev
    // The repaint in the new grammar lands in the volatile frame.
    await waitForFrame(frame, "─ model mock");
    const dev = frame();
    expect(dev).toContain("answer one");
    expect(dev).not.toContain("100 in");
    expect(dev).toContain("◉ dev");

    // a subsequent turn still settles in dev
    i.stdin.write("two");
    await new Promise((r) => setTimeout(r, 20));
    i.stdin.write("\r");
    await waitForCondition(() => seen("answer two"), () => "second turn reply never appeared");
    expect(frame()).not.toContain("200 in");
    i.unmount();
  });
});
