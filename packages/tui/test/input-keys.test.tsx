import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MultilineInput, type ComposerHandle } from "../src/Input";
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

describe("multiline input external prefill", () => {
  test("replaces the draft without submitting it", async () => {
    const submitted: string[] = [];
    const i = render(<MultilineInput placeholder="p" focused onSubmit={(text) => submitted.push(text)} />);
    await sleep(30);
    i.stdin.write("draft");
    await sleep(30);
    i.rerender(<MultilineInput placeholder="p" focused prefill="/implement #123" onSubmit={(text) => submitted.push(text)} />);
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (frame) => frame.includes("/implement #123"));
    expect(submitted).toEqual([]);
    i.unmount();
  });
});

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

  test("slash completion accepts a matching command with Tab (trailing space, Enter then sends)", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; }, [{ name: "/workflow", description: "toggle workflow", custom: false }]);
    i.stdin.write("/work");
    await sleep(20);
    i.stdin.write("\t");
    await sleep(20);
    // Tab completes into the draft (trailing space); nothing is sent yet
    expect(submitted).toBe("");
    expect(i.frame().split("\n")[0]?.trim()).toBe("/workflow");
    i.stdin.write("\r");
    await sleep(30);
    // submit trims: the command text (without the completion space) is sent
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

describe("composer handle (#1009)", () => {
  /** The handle App's ctrl+c handler reads. It answers for the whole
   * precondition, so a blocked (a turn, a modal) or unfocused (a chip holds
   * the keys) composer never swallows a press meant to arm the exit. */
  test("clears a draft only while focused and enabled, and publishes nothing once unmounted", async () => {
    const handle = React.createRef<ComposerHandle>();
    const submitted: string[] = [];
    const view = (props: { focused?: boolean; disabled?: boolean } = {}) => (
      <MultilineInput
        placeholder="p"
        composerHandle={handle}
        onSubmit={(text) => submitted.push(text)}
        {...props}
      />
    );
    const i = render(view({ focused: true, disabled: false }));
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => f.includes("p"));
    expect(handle.current?.canClear()).toBe(false); // empty: ctrl+c stays an exit press
    i.stdin.write("abc");
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => f.includes("abc"));
    expect(handle.current?.canClear()).toBe(true);
    for (const blocked of [{ focused: true, disabled: true }, { focused: false, disabled: false }]) {
      i.rerender(view(blocked));
      await sleep(20);
      expect(handle.current?.canClear()).toBe(false);
    }
    i.rerender(view({ focused: true, disabled: false }));
    await sleep(20);
    handle.current!.clear();
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => !f.includes("abc"));
    expect(submitted).toEqual([]); // a clear is not a send
    i.unmount();
    expect(handle.current).toBeNull();
  });

  test("a clear ends the history walk: ↓ cannot resurrect the pre-recall draft", async () => {
    const handle = React.createRef<ComposerHandle>();
    const i = render(<MultilineInput placeholder="p" composerHandle={handle} onSubmit={() => {}} />);
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => f.includes("p"));
    i.stdin.write("one");
    await sleep(20);
    i.stdin.write("\r"); // submit: "one" enters the history
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => !f.includes("one"));
    i.stdin.write("keep");
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => f.includes("keep"));
    i.stdin.write("\x1b[A"); // ↑ at the end of the line: cursor to column 0
    await sleep(20);
    i.stdin.write("\x1b[A"); // ↑ again: recall "one"; "keep" is now the walk's draft
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => f.includes("one"));
    handle.current!.clear();
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => !f.includes("one"));
    i.stdin.write("\x1b[B"); // ↓ — a still-open walk would hand the cleared draft back
    await sleep(60);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("keep");
    i.unmount();
  });
});

// #1022: the composer publishes its rendered height, and its owner caps it —
// the volatile frame's budget is built from what the footer really occupies.
describe("composer row accounting", () => {
  test("reports the rows it renders as the draft grows", async () => {
    const reported: number[] = [];
    const i = render(<MultilineInput placeholder="p" focused onRowsChange={(rows) => reported.push(rows)} onSubmit={() => {}} />);
    await untilFrame(() => String(reported.at(-1)), (f) => f === "1");
    expect(reported.at(-1)).toBe(1); // the empty draft paints its placeholder row
    i.stdin.write("word ".repeat(200));
    await untilFrame(() => String(reported.at(-1)), (f) => Number(f) >= 3);
    expect(reported.at(-1)!).toBeGreaterThanOrEqual(3);
    i.unmount();
  });

  test("maxRows caps the whole composer — an open completion popup cannot grow past it", async () => {
    // The popup is part of what the composer renders, so it shares the cap:
    // a CAP that bounded only the draft row would let the frame grow past
    // the terminal exactly as an uncapped draft did (#1022).
    const reported: number[] = [];
    const commands: CommandEntry[] = Array.from({ length: 8 }, (_, i) => ({ name: `/cmd${i}`, description: "x", custom: false }));
    const i = render(<MultilineInput placeholder="p" focused maxRows={3} commands={commands} onRowsChange={(rows) => reported.push(rows)} onSubmit={() => {}} />);
    await untilFrame(() => String(reported.at(-1)), (f) => f === "1");
    i.stdin.write("/");
    await untilFrame(() => stripAnsi(i.lastFrame() ?? ""), (f) => f.includes("/cmd1"));
    expect(reported.at(-1)!).toBeLessThanOrEqual(3);
    // The popup stays usable: its rows are drawn (the list is not dropped).
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("/cmd1");
    i.unmount();
  });

  test("maxRows caps the window it paints, and the draft scrolls instead of vanishing", async () => {    const reported: number[] = [];
    const text = "word ".repeat(200);
    const i = render(<MultilineInput placeholder="p" focused maxRows={2} onRowsChange={(rows) => reported.push(rows)} onSubmit={() => {}} />);
    await untilFrame(() => String(reported.at(-1)), (f) => f === "1");
    i.stdin.write(text);
    await untilFrame(() => String(reported.at(-1)), (f) => Number(f) === 2);
    expect(reported.at(-1)).toBe(2);
    // The cap moves the window (the cursor stays visible), never the text:
    // submitting returns the whole draft.
    let submitted = "";
    i.rerender(<MultilineInput placeholder="p" focused maxRows={2} onSubmit={(value) => { submitted = value; }} />);
    await sleep(30);
    i.stdin.write("\r");
    await untilFrame(() => String(submitted.length), (f) => Number(f) > 0);
    expect(submitted.trim()).toBe(text.trim());
    i.unmount();
  });
});
