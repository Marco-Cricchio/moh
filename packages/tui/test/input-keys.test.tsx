import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MultilineInput } from "../src/Input";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Renders the input in isolation and returns a frame prober. */
async function mount(onSubmit: () => void) {
  const i = render(<MultilineInput placeholder="p" focused onSubmit={onSubmit} />);
  await sleep(30);
  return {
    stdin: i.stdin,
    frame: () => stripAnsi(i.lastFrame() ?? ""),
    unmount: () => i.unmount(),
  };
}

describe("multiline input newline/submit keys (raw bytes through Ink's parser)", () => {
  test("ctrl+j byte (\\n) inserts a newline, never submits", async () => {
    let submitted = 0;
    const i = await mount(() => {
      submitted += 1;
    });
    i.stdin.write("ab");
    await sleep(20);
    i.stdin.write("\x0a"); // raw ctrl+j — Ink 6 parses it as name "enter", input "\n"
    await sleep(30);
    i.stdin.write("cd");
    await sleep(20);
    const frame = i.frame();
    expect(submitted).toBe(0);
    expect(frame).toContain("ab");
    expect(frame).toContain("cd");
    // two draft lines: the cursor block sits on the second one
    expect(frame.split("\n").filter((l) => l.includes("cd")).length).toBe(1);
    i.unmount();
  });

  test("plain Enter (\\r) submits", async () => {
    let submitted = 0;
    const i = await mount(() => {
      submitted += 1;
    });
    i.stdin.write("hi");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe(1);
    i.unmount();
  });

  test("shift+enter (kitty CSI-u \\x1b[13;2u) inserts a newline", async () => {
    let submitted = 0;
    const i = await mount(() => {
      submitted += 1;
    });
    i.stdin.write("one");
    await sleep(20);
    i.stdin.write("\x1b[13;2u"); // shift+enter as a kitty-protocol terminal sends it
    await sleep(30);
    i.stdin.write("two");
    await sleep(20);
    const frame = i.frame();
    expect(submitted).toBe(0);
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    i.unmount();
  });

  test("option+enter (\x1b\r, Terminal.app/iTerm2 form) inserts a newline", async () => {
    let submitted = 0;
    const i = await mount(() => {
      submitted += 1;
    });
    i.stdin.write("one");
    await sleep(20);
    i.stdin.write("\x1b\r"); // option/alt+enter without kitty protocol
    await sleep(30);
    i.stdin.write("two");
    await sleep(20);
    const frame = i.frame();
    expect(submitted).toBe(0);
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    i.unmount();
  });
});
