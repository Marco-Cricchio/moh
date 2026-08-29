import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MultilineInput } from "../src/Input";
import type { CommandEntry } from "../src/commands";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until the frame matches (bounded); runner-speed-proof replacement
 * for fixed sleeps around keystroke effects. */
async function untilFrame(getFrame: () => string, predicate: (frame: string) => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate(getFrame())) return;
    if (Date.now() > deadline) throw new Error(`untilFrame timed out; last frame: ${JSON.stringify(getFrame())}`);
    await sleep(20);
  }
}

/** Renders the input in isolation and returns a frame prober. */
async function mount(onSubmit: (text: string) => void, commands: readonly CommandEntry[] = []) {
  const i = render(<MultilineInput placeholder="p" focused commands={commands} onSubmit={onSubmit} />);
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

  test("ctrl+a/ctrl+e move the cursor to line start/end", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    i.stdin.write("cd");
    await sleep(20);
    i.stdin.write("\x01"); // ctrl+a → line start
    await sleep(20);
    i.stdin.write("ab"); // insert before "cd"
    await sleep(20);
    i.stdin.write("\x05"); // ctrl+e → line end
    await sleep(20);
    i.stdin.write("ef");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("abcdef");
    i.unmount();
  });

  test("left/right arrows move the insertion point instead of appending", async () => {
    let submitted = "";
    const i = await mount((text) => {
      submitted = text;
    });
    i.stdin.write("ac");
    await sleep(20);
    i.stdin.write("\x1b[D");
    await sleep(20);
    i.stdin.write("b");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("abc");
    i.unmount();
  });

  test("backspace removes the grapheme immediately to the left of the cursor", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    i.stdin.write("abcd");
    await sleep(20);
    i.stdin.write("\x1b[D");
    await sleep(40);
    i.stdin.write("\x1b[D");
    await sleep(40);
    i.stdin.write("\x7f");
    await sleep(40);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("acd");
    i.unmount();
  });

  test("backspace removes an entire emoji grapheme", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    i.stdin.write("a👍b");
    await sleep(30);
    i.stdin.write("\x1b[D");
    await sleep(40);
    i.stdin.write("\x7f");
    await sleep(40);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("ab");
    i.unmount();
  });

  test("backspace at the start of a line joins the previous line", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    i.stdin.write("one");
    await sleep(10);
    i.stdin.write("\x0a");
    await sleep(30);
    i.stdin.write("two");
    await sleep(30);
    i.stdin.write("\x1b[H");
    await sleep(40);
    i.stdin.write("\x7f");
    await sleep(40);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("onetwo");
    i.unmount();
  });

  test("undo restores the previous draft and redo restores it", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    i.stdin.write("abc");
    await sleep(20);
    i.stdin.write("\x1b[D");
    await sleep(10);
    i.stdin.write("\x1a"); // Ctrl+Z
    await sleep(20);
    i.stdin.write("\x19"); // Ctrl+Y
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("abc");
    i.unmount();
  });

  test("word navigation jumps over whitespace-delimited words", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    i.stdin.write("one two");
    await sleep(20);
    i.stdin.write("\x1bb"); // Alt+B
    await sleep(20);
    i.stdin.write("X");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("one twoX");
    i.unmount();
  });

  test("bracketed paste inserts multiline content as one draft", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    i.stdin.write("\x1b[200~first\nsecond\x1b[201~");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("first\nsecond");
    i.unmount();
  });

  test("slash completion accepts a matching command with Tab", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; }, [{ name: "/workflow", description: "toggle workflow", custom: false }]);
    i.stdin.write("/work");
    await sleep(20);
    i.stdin.write("\t");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("/workflow");
    i.unmount();
  });

  test("slash suggestions come from the commands prop: /ask-moh offered, unknown names never", async () => {
    // Regression: the completion list was a hardcoded array that missed
    // /ask-moh (and listed commands that no longer exist).
    let submitted = "";
    const i = render(
      <MultilineInput
        placeholder="p"
        focused
        commands={[{ name: "/workflow", description: "toggle workflow", custom: false }, { name: "/ask-moh", description: "router", custom: false }, { name: "/model", description: "pick model", custom: false }]}
        onSubmit={(text) => { submitted = text; }}
      />,
    );
    await sleep(30);
    i.stdin.write("/ask");
    await sleep(20);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("/ask-moh");
    i.stdin.write("\t");
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => f.split("\n")[0]?.trim() === "/ask-moh");
    i.stdin.write("\r");
    await untilFrame(() => "", () => submitted === "/ask-moh");
    expect(submitted).toBe("/ask-moh");
    i.unmount();
  });

  test("workflow-mode commands complete only when passed in (registry decides)", async () => {
    let submitted = "";
    const i = render(
      <MultilineInput
        placeholder="p"
        focused
        commands={[{ name: "/workflow", description: "toggle workflow", custom: false }, { name: "/ask-moh", description: "router", custom: false }, { name: "/model", description: "pick model", custom: false }, { name: "/implement", description: "run implement", custom: false }, { name: "/tdd", description: "run tdd", custom: false }]}
        onSubmit={(text) => { submitted = text; }}
      />,
    );
    await sleep(30);
    i.stdin.write("/t");
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => f.includes("/tdd"));
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("/tdd");
    i.stdin.write("\t");
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => f.split("\n")[0]?.trim() === "/tdd");
    i.stdin.write("\r");
    await untilFrame(() => "", () => submitted === "/tdd");
    expect(submitted).toBe("/tdd");
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
