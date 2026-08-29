import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MultilineInput, slashSuggestions } from "../src/Input";
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
async function mount(onSubmit: (text: string) => void, commands: readonly string[] = []) {
  const i = render(<MultilineInput placeholder="p" focused commands={commands} onSubmit={onSubmit} />);
  await sleep(30);
  return {
    stdin: i.stdin,
    frame: () => stripAnsi(i.lastFrame() ?? ""),
    unmount: () => i.unmount(),
  };
}

/** The ten base commands, alphabetical (the popup's fixed order). */
const BASE = [
  "/ask-moh",
  "/commands",
  "/mode",
  "/model",
  "/reload",
  "/settings",
  "/theme",
  "/thinking",
  "/wayfinder",
  "/workflow",
];

describe("slash popup: candidate list (pure)", () => {
  test("single-line slash prefix filters case-insensitively, alphabetically", () => {
    const unordered = ["/workflow", "/model", "/mode", "/ask-moh"];
    expect(slashSuggestions("/mo", unordered)).toEqual(["/mode", "/model"]);
    expect(slashSuggestions("/MO", unordered)).toEqual(["/mode", "/model"]);
    expect(slashSuggestions("/", unordered)).toEqual(["/ask-moh", "/mode", "/model", "/workflow"]);
  });

  test("spaces, non-slash drafts and multiline drafts close the list", () => {
    const commands = ["/mode", "/model"];
    expect(slashSuggestions("/mode ", commands)).toEqual([]);
    expect(slashSuggestions("hello", commands)).toEqual([]);
    expect(slashSuggestions("", commands)).toEqual([]);
    // exact match stays open (Enter must run it from the list) — a longer
    // sibling sharing the prefix stays visible too, which is correct
    // prefix filtering, not a bug.
    expect(slashSuggestions("/mode", commands)).toEqual(["/mode", "/model"]);
  });
});

describe("slash completion popup (raw bytes through Ink's parser)", () => {
  test("typing / opens the alphabetical popup under the textarea", async () => {
    const i = await mount(() => {}, BASE);
    i.stdin.write("/");
    await sleep(60);
    const frame = i.frame();
    for (const name of BASE) expect(frame).toContain(name);
    // alphabetical: ask-moh before commands before mode …
    const positions = BASE.map((name) => frame.indexOf(name));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // the first row is selected
    expect(frame).toContain("▶ /ask-moh");
    i.unmount();
  });

  test("the popup filters as the user types more characters", async () => {
    const i = await mount(() => {}, BASE);
    i.stdin.write("/th");
    await sleep(60);
    const frame = i.frame();
    expect(frame).toContain("/theme");
    expect(frame).toContain("/thinking");
    expect(frame).not.toContain("/ask-moh");
    i.unmount();
  });

  test("arrow keys move the popup selection and Enter runs the command", async () => {
    let submitted = "";
    const i = await mount((t) => { submitted = t; }, ["/mode", "/model"]);
    i.stdin.write("/mo");
    await sleep(60);
    i.stdin.write("\x1b[B"); // down → /model
    await sleep(60);
    expect(i.frame()).toContain("▶ /model");
    i.stdin.write("\r");
    await untilFrame(() => "", () => submitted === "/model", 3000);
    expect(submitted).toBe("/model");
    i.unmount();
  });

  test("Tab completes the selection into the textarea; the draft stays editable (focus never leaves it)", async () => {
    const i = await mount(() => {}, ["/mode", "/model"]);
    i.stdin.write("/mo");
    await sleep(60);
    i.stdin.write("\t"); // completes /mode into the textarea
    await sleep(60);
    expect(i.frame().split("\n")[0]?.trim()).toBe("/mode");
    // focus is still the textarea: typing continues to edit the draft
    i.stdin.write("d");
    await sleep(60);
    expect(i.frame().split("\n")[0]?.trim()).toBe("/moded");
    // the popup still follows the (now non-matching) draft — it closed
    expect(i.frame()).not.toContain("▶");
    i.unmount();
  });

  test("backspacing the slash closes the popup", async () => {
    const i = await mount(() => {}, BASE);
    i.stdin.write("/mo");
    await sleep(60);
    expect(i.frame()).toContain("/mode");
    i.stdin.write("\x7f"); // → /m
    await sleep(60);
    expect(i.frame()).toContain("/mode");
    expect(i.frame()).toContain("/model");
    i.stdin.write("\x7f"); // → /
    await sleep(60);
    expect(i.frame()).toContain("/ask-moh");
    i.stdin.write("\x7f"); // → empty
    await sleep(60);
    expect(i.frame()).not.toContain("/ask-moh");
    i.unmount();
  });

  test("Enter on the exact match runs the command straight from the popup", async () => {
    let submitted = "";
    const i = await mount((t) => { submitted = t; }, BASE);
    i.stdin.write("/model");
    await sleep(60);
    expect(i.frame()).toContain("/model");
    i.stdin.write("\r");
    await untilFrame(() => "", () => submitted === "/model", 3000);
    expect(submitted).toBe("/model");
    i.unmount();
  });
});
