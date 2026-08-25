import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MultilineInput } from "../src/Input";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Renders the input in isolation and returns a frame prober. */
async function mount(onSubmit: (text: string) => void, commands: readonly string[] = []) {
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
    const i = await mount((text) => { submitted = text; }, ["/workflow"]);
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
        commands={["/workflow", "/ask-moh", "/model"]}
        onSubmit={(text) => { submitted = text; }}
      />,
    );
    await sleep(30);
    i.stdin.write("/ask");
    await sleep(20);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("/ask-moh");
    i.stdin.write("\t");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(submitted).toBe("/ask-moh");
    i.unmount();
  });

  test("workflow-mode commands complete only when passed in (registry decides)", async () => {
    let submitted = "";
    const i = render(
      <MultilineInput
        placeholder="p"
        focused
        commands={["/workflow", "/ask-moh", "/model", "/implement", "/tdd"]}
        onSubmit={(text) => { submitted = text; }}
      />,
    );
    await sleep(30);
    i.stdin.write("/t");
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("/tdd");
    i.stdin.write("\t");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
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
