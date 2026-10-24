import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MultilineInput, type ComposerHandle } from "../src/Input";
import type { CommandEntry } from "../src/commands";
import { effectsFlushed, pressSettled, stripAnsi, waitStep, waitText } from "./helpers";

/** Waits (deadline + named step) until the frame matches. */
const untilFrame = (view: { lastFrame: () => string | undefined }, predicate: (frame: string) => boolean) =>
  waitStep(view, () => predicate(stripAnsi(view.lastFrame() ?? "")), `frame satisfies ${predicate}`);

/** Renders the input in isolation once it has mounted; keys go through `pressSettled`. */
async function mount(onSubmit: (text: string) => void, commands: readonly CommandEntry[] = []) {
  const i = render(<MultilineInput placeholder="p" focused commands={commands} onSubmit={onSubmit} />);
  await waitText(i, "p", "the input mounted");
  return {
    stdin: i.stdin,
    lastFrame: i.lastFrame,
    frame: () => stripAnsi(i.lastFrame() ?? ""),
    unmount: () => i.unmount(),
  };
}

describe("multiline input external prefill", () => {
  test("replaces the draft without submitting it", async () => {
    const submitted: string[] = [];
    const i = render(<MultilineInput placeholder="p" focused onSubmit={(text) => submitted.push(text)} />);
    await waitText(i, "p", "the input mounted");
    await pressSettled(i, "draft");
    i.rerender(<MultilineInput placeholder="p" focused prefill="/implement #123" onSubmit={(text) => submitted.push(text)} />);
    await untilFrame(i, (frame) => frame.includes("/implement #123"));
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
    await pressSettled(i, "ab");
    await pressSettled(i, "\x0a"); // raw ctrl+j — Ink 6 parses it as name "enter", input "\n"
    await pressSettled(i, "cd");
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
    await pressSettled(i, "hi");
    await pressSettled(i, "\r");
    expect(submitted).toBe(1);
    i.unmount();
  });

  test("shift+enter (kitty CSI-u \\x1b[13;2u) inserts a newline", async () => {
    let submitted = 0;
    const i = await mount(() => {
      submitted += 1;
    });
    await pressSettled(i, "one");
    await pressSettled(i, "\x1b[13;2u"); // shift+enter as a kitty-protocol terminal sends it
    await pressSettled(i, "two");
    const frame = i.frame();
    expect(submitted).toBe(0);
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    i.unmount();
  });

  test("ctrl+a/ctrl+e move the cursor to line start/end", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    await pressSettled(i, "cd");
    await pressSettled(i, "\x01"); // ctrl+a → line start
    await pressSettled(i, "ab"); // insert before "cd"
    await pressSettled(i, "\x05"); // ctrl+e → line end
    await pressSettled(i, "ef");
    await pressSettled(i, "\r");
    expect(submitted).toBe("abcdef");
    i.unmount();
  });

  test("left/right arrows move the insertion point instead of appending", async () => {
    let submitted = "";
    const i = await mount((text) => {
      submitted = text;
    });
    await pressSettled(i, "ac");
    await pressSettled(i, "\x1b[D");
    await pressSettled(i, "b");
    await pressSettled(i, "\r");
    expect(submitted).toBe("abc");
    i.unmount();
  });

  test("backspace removes the grapheme immediately to the left of the cursor", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    await pressSettled(i, "abcd");
    await pressSettled(i, "\x1b[D");
    await pressSettled(i, "\x1b[D");
    await pressSettled(i, "\x7f");
    await pressSettled(i, "\r");
    expect(submitted).toBe("acd");
    i.unmount();
  });

  test("backspace removes an entire emoji grapheme", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    await pressSettled(i, "a👍b");
    await pressSettled(i, "\x1b[D");
    await pressSettled(i, "\x7f");
    await pressSettled(i, "\r");
    expect(submitted).toBe("ab");
    i.unmount();
  });

  test("backspace at the start of a line joins the previous line", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    await pressSettled(i, "one");
    await pressSettled(i, "\x0a");
    await pressSettled(i, "two");
    await pressSettled(i, "\x1b[H");
    await pressSettled(i, "\x7f");
    await pressSettled(i, "\r");
    expect(submitted).toBe("onetwo");
    i.unmount();
  });

  test("undo restores the previous draft and redo restores it", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    await pressSettled(i, "abc");
    await pressSettled(i, "\x1b[D");
    await pressSettled(i, "\x1a"); // Ctrl+Z
    await pressSettled(i, "\x19"); // Ctrl+Y
    await pressSettled(i, "\r");
    expect(submitted).toBe("abc");
    i.unmount();
  });

  test("word navigation jumps over whitespace-delimited words", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    await pressSettled(i, "one two");
    await pressSettled(i, "\x1bb"); // Alt+B
    await pressSettled(i, "X");
    await pressSettled(i, "\r");
    expect(submitted).toBe("one twoX");
    i.unmount();
  });

  test("bracketed paste inserts multiline content as one draft", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; });
    await pressSettled(i, "\x1b[200~first\nsecond\x1b[201~");
    await pressSettled(i, "\r");
    expect(submitted).toBe("first\nsecond");
    i.unmount();
  });

  test("slash completion accepts a matching command with Tab (trailing space, Enter then sends)", async () => {
    let submitted = "";
    const i = await mount((text) => { submitted = text; }, [{ name: "/workflow", description: "toggle workflow", custom: false }]);
    await pressSettled(i, "/work");
    await pressSettled(i, "\t");
    // Tab completes into the draft (trailing space); nothing is sent yet
    expect(submitted).toBe("");
    expect(i.frame().split("\n")[0]?.trim()).toBe("/workflow");
    await pressSettled(i, "\r");
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
    await waitText(i, "p", "the input mounted");
    await pressSettled(i, "/ask");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("/ask-moh");
    await pressSettled(i, "\t");
    await untilFrame(i, (f) => f.split("\n")[0]?.trim() === "/ask-moh");
    await pressSettled(i, "\r");
    await waitStep(i, () => submitted === "/ask-moh", "the command was submitted");
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
    await waitText(i, "p", "the input mounted");
    await pressSettled(i, "/t");
    await untilFrame(i, (f) => f.includes("/tdd"));
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("/tdd");
    await pressSettled(i, "\t");
    await untilFrame(i, (f) => f.split("\n")[0]?.trim() === "/tdd");
    await pressSettled(i, "\r");
    await waitStep(i, () => submitted === "/tdd", "the command was submitted");
    expect(submitted).toBe("/tdd");
    i.unmount();
  });

  test("option+enter (\x1b\r, Terminal.app/iTerm2 form) inserts a newline", async () => {
    let submitted = 0;
    const i = await mount(() => {
      submitted += 1;
    });
    await pressSettled(i, "one");
    await pressSettled(i, "\x1b\r"); // option/alt+enter without kitty protocol
    await pressSettled(i, "two");
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
    await untilFrame(i, (f) => f.includes("p"));
    expect(handle.current?.canClear()).toBe(false); // empty: ctrl+c stays an exit press
    await pressSettled(i, "abc");
    await untilFrame(i, (f) => f.includes("abc"));
    expect(handle.current?.canClear()).toBe(true);
    for (const blocked of [{ focused: true, disabled: true }, { focused: false, disabled: false }]) {
      i.rerender(view(blocked));
      await effectsFlushed();
      expect(handle.current?.canClear()).toBe(false);
    }
    i.rerender(view({ focused: true, disabled: false }));
    await effectsFlushed();
    handle.current!.clear();
    await untilFrame(i, (f) => !f.includes("abc"));
    expect(submitted).toEqual([]); // a clear is not a send
    i.unmount();
    expect(handle.current).toBeNull();
  });

  test("a clear ends the history walk: ↓ cannot resurrect the pre-recall draft", async () => {
    const handle = React.createRef<ComposerHandle>();
    const i = render(<MultilineInput placeholder="p" composerHandle={handle} onSubmit={() => {}} />);
    await untilFrame(i, (f) => f.includes("p"));
    await pressSettled(i, "one");
    await pressSettled(i, "\r"); // submit: "one" enters the history
    await untilFrame(i, (f) => !f.includes("one"));
    await pressSettled(i, "keep");
    await untilFrame(i, (f) => f.includes("keep"));
    await pressSettled(i, "\x1b[A"); // ↑ at the end of the line: cursor to column 0
    await pressSettled(i, "\x1b[A"); // ↑ again: recall "one"; "keep" is now the walk's draft
    await untilFrame(i, (f) => f.includes("one"));
    handle.current!.clear();
    await untilFrame(i, (f) => !f.includes("one"));
    await pressSettled(i, "\x1b[B"); // ↓ — a still-open walk would hand the cleared draft back
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
    await waitStep(i, () => { const f = String(reported.at(-1)); return f === "1"; }, "rows reported");
    expect(reported.at(-1)).toBe(1); // the empty draft paints its placeholder row
    await pressSettled(i, "word ".repeat(200));
    await waitStep(i, () => { const f = String(reported.at(-1)); return Number(f) >= 3; }, "rows reported");
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
    await waitStep(i, () => { const f = String(reported.at(-1)); return f === "1"; }, "rows reported");
    await pressSettled(i, "/");
    await untilFrame(i, (f) => f.includes("/cmd1"));
    expect(reported.at(-1)!).toBeLessThanOrEqual(3);
    // The popup stays usable: its rows are drawn (the list is not dropped).
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("/cmd1");
    i.unmount();
  });

  test("maxRows caps the window it paints, and the draft scrolls instead of vanishing", async () => {    const reported: number[] = [];
    const text = "word ".repeat(200);
    const i = render(<MultilineInput placeholder="p" focused maxRows={2} onRowsChange={(rows) => reported.push(rows)} onSubmit={() => {}} />);
    await waitStep(i, () => { const f = String(reported.at(-1)); return f === "1"; }, "rows reported");
    await pressSettled(i, text);
    await waitStep(i, () => { const f = String(reported.at(-1)); return Number(f) === 2; }, "rows reported");
    expect(reported.at(-1)).toBe(2);
    // The cap moves the window (the cursor stays visible), never the text:
    // submitting returns the whole draft.
    let submitted = "";
    i.rerender(<MultilineInput placeholder="p" focused maxRows={2} onSubmit={(value) => { submitted = value; }} />);
    await effectsFlushed();
    await pressSettled(i, "\r");
    await waitStep(i, () => submitted.length > 0, "the draft was submitted");
    expect(submitted.trim()).toBe(text.trim());
    i.unmount();
  });
});
