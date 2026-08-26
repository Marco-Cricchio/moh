import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** #201: the mode switch repaints the visible transcript in the new
 * grammar instead of only affecting future turns. */
describe("mode switch repaints the transcript (#201)", () => {
  test("a turn settled in vibe re-renders in dev grammar after the switch", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["answer one"], finish: "stop", usage: { inputTokens: 100, outputTokens: 10 } },
      { deltas: ["answer two"], finish: "stop", usage: { inputTokens: 200, outputTokens: 20 } },
    ]);
    const i = render(
      <App cwd={process.cwd()} home={mkdtempSync(join(tmpdir(), "moh-rep-"))} provider={provider} startInChat skipOnboarding />,
    );
    await sleep(30);
    i.stdin.write("one");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(300);
    const vibe = stripAnsi(i.lastFrame() ?? "");
    expect(vibe).toContain("answer one");
    expect(vibe).not.toContain("100 in");

    i.stdin.write("\x0f"); // ctrl+o → dev
    await sleep(150);
    const dev = stripAnsi(i.lastFrame() ?? "");
    expect(dev).toContain("answer one");
    expect(dev).toContain("─ model mock"); // reprinted in dev grammar, no usage line (#213)
    expect(dev).not.toContain("100 in");
    expect(dev).toContain("◉ dev");

    // a subsequent turn still settles in dev
    i.stdin.write("two");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(300);
    const after = stripAnsi(i.lastFrame() ?? "");
    expect(after).toContain("answer two");
    expect(after).toContain("─ model mock");
    expect(after).not.toContain("200 in");
    i.unmount();
  });
});
