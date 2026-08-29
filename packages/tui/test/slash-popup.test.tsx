import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultilineInput, slashSuggestions } from "../src/Input";
import type { CommandEntry } from "../src/commands";
import { App } from "../src/App";
import { MockProvider } from "@moh/core";
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

/** The ten base commands, alphabetical (the popup's fixed order), as
 * popup entries with descriptions and the `[s]` provenance marker. */
const BASE: CommandEntry[] = [
  { name: "/ask-moh", description: "which skill or flow fits? router over moh skills + docs", custom: false },
  { name: "/commands", description: "open the all-commands panel", custom: false },
  { name: "/mode", description: "switch vibe / dev mode", custom: false },
  { name: "/model", description: "open the model picker modal", custom: false },
  { name: "/reload", description: "hot-reload moh.json and user config into the live session", custom: false },
  { name: "/settings", description: "open the settings panel", custom: false },
  { name: "/theme", description: "cycle the color theme", custom: false },
  { name: "/thinking", description: "reasoning display and thinking level", custom: false },
  { name: "/wayfinder", description: "open the wayfinder frontier panel", custom: false },
  { name: "/workflow", description: "toggle workflow mode", custom: false },
];

const asNames = (entries: readonly CommandEntry[]) => entries.map((entry) => entry.name);

describe("slash popup: candidate list (pure)", () => {
  test("single-line slash prefix filters case-insensitively, caller order kept", () => {
    const unordered = [
      { name: "/workflow", description: "toggle workflow", custom: false },
      { name: "/model", description: "pick model", custom: false },
      { name: "/mode", description: "switch mode", custom: false },
      { name: "/ask-moh", description: "router", custom: false },
    ];
    // the filter preserves the caller's order (commandEntries sorts); on
    // the unsorted fixture that means model before mode.
    expect(asNames(slashSuggestions("/mo", unordered))).toEqual(["/model", "/mode"]);
    expect(asNames(slashSuggestions("/MO", unordered))).toEqual(["/model", "/mode"]);
    // with the sorted (production) order the filtered list stays sorted
    const sorted = [unordered[3]!, unordered[2]!, unordered[1]!, unordered[0]!];
    expect(asNames(slashSuggestions("/", sorted))).toEqual(["/ask-moh", "/mode", "/model", "/workflow"]);
  });

  test("spaces, non-slash drafts and multiline drafts close the list", () => {
    const commands = [
      { name: "/mode", description: "switch mode", custom: false },
      { name: "/model", description: "pick model", custom: false },
    ];
    expect(slashSuggestions("/mode ", commands)).toEqual([]);
    expect(slashSuggestions("hello", commands)).toEqual([]);
    expect(slashSuggestions("", commands)).toEqual([]);
    // exact match stays open (Enter must run it from the list) — a longer
    // sibling sharing the prefix stays visible too, which is correct
    // prefix filtering, not a bug.
    expect(asNames(slashSuggestions("/mode", commands))).toEqual(["/mode", "/model"]);
  });
});

describe("slash completion popup (raw bytes through Ink's parser)", () => {
  test("typing / opens the alphabetical popup under the textarea (max 4 visible)", async () => {
    const i = await mount(() => {}, BASE);
    i.stdin.write("/");
    await sleep(60);
    const frame = i.frame();
    // the popup window shows the first four commands in alphabetical order
    for (const name of asNames(BASE.slice(0, 4))) expect(frame).toContain(name);
    expect(frame).not.toContain("/settings");
    expect(frame).toContain("↓ 6 more");
    // the first row is selected
    expect(frame).toContain("▶ [s] /ask-moh");
    // the selection scrolls the window: ↓×4 brings /reload into view
    for (let k = 0; k < 4; k++) { i.stdin.write("\x1b[B"); await sleep(30); }
    expect(i.frame()).toContain("▶ [s] /reload");
    expect(i.frame()).toContain("↑ 1 more");
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
    const i = await mount((t) => { submitted = t; }, [{ name: "/mode", description: "switch mode", custom: false }, { name: "/model", description: "pick model", custom: false }]);
    i.stdin.write("/mo");
    await sleep(60);
    i.stdin.write("\x1b[B"); // down → /model
    await sleep(60);
    expect(i.frame()).toContain("▶ [s] /model");
    i.stdin.write("\r");
    await untilFrame(() => "", () => submitted === "/model", 3000);
    expect(submitted).toBe("/model");
    i.unmount();
  });

  test("Tab completes the selection into the textarea; the draft stays editable (focus never leaves it)", async () => {
    const i = await mount(() => {}, [{ name: "/mode", description: "switch mode", custom: false }, { name: "/model", description: "pick model", custom: false }]);
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

  test("popup rows carry the provenance marker and the short description", async () => {
    const i = await mount(() => {}, [...BASE, { name: "/my-own", description: "a user-defined command", custom: true }]);
    i.stdin.write("/");
    await sleep(60);
    const frame = i.frame();
    // built-ins render [s], the user-defined one [u]; both show — description
    expect(frame).toContain("[s] /ask-moh — which skill or flow fits?");
    // alphabetical: /my-own sits between /mode and /reload… scroll there
    i.stdin.write("my");
    await sleep(60);
    expect(i.frame()).toContain("▶ [u] /my-own — a user-defined command");
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

describe("slash popup at App level (Tab defers to the popup)", () => {
  test("Tab with the popup open completes the command and keeps the textarea focused (no chip focus)", async () => {
    const i = render(
      <App cwd={process.cwd()} home={mkdtempSync(join(tmpdir(), "moh-tabfocus-"))} provider={MockProvider.demo()} startInChat skipOnboarding />,
    );
    await sleep(80);
    i.stdin.write("/");
    await sleep(80);
    i.stdin.write("\x1b[B"); // select /commands
    await sleep(80);
    i.stdin.write("\t");
    await sleep(150);
    const frame = stripAnsi(i.lastFrame() ?? "");
    // the command completed into the textarea…
    expect(frame.split("\n").some((l) => l.trim() === "/commands")).toBe(true);
    // …and typing still edits the draft (focus never left the textarea)
    i.stdin.write("x");
    await sleep(80);
    const after = stripAnsi(i.lastFrame() ?? "");
    expect(after.split("\n").some((l) => l.trim() === "/commandsx")).toBe(true);
    i.unmount();
  });
});
