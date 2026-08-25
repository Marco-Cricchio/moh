import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App";
import { MockProvider } from "@moh/core";
import { stripAnsi } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-tui-exit-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** After App exit the tree is frozen: typed text never renders. */
async function typedShowsUp(i: { stdin: { write(s: string): void }; lastFrame(): string | undefined }, text: string) {
  i.stdin.write(text);
  await sleep(60);
  return stripAnsi(i.lastFrame() ?? "").includes(text);
}

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
    await sleep(30);
    i.stdin.write("\x03"); // ctrl+c
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("press ctrl+c again to exit");
    expect(await typedShowsUp(i, "still-alive")).toBe(true); // not exited yet
    i.stdin.write("\x03");
    await sleep(50);
    expect(await typedShowsUp(i, "gone")).toBe(false); // tree frozen: exited
  });

  test("a lone ctrl+c does not exit", async () => {
    const i = mount();
    await sleep(30);
    i.stdin.write("\x03");
    await sleep(1600); // past the 1.5s arm window
    i.stdin.write("\x03");
    await sleep(30);
    expect(await typedShowsUp(i, "still-here")).toBe(true);
    i.unmount();
  });
});
