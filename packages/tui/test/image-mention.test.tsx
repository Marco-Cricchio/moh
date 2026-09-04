/**
 * Image mentions in the TUI (#490, vision note 4): a bracketed paste that
 * is an existing path converts to an `@path` mention (drag-and-drop), the
 * preview protocol detection honors the `images.preview` setting and the
 * environment, and the fallback chip is the universal text marker.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MultilineInput, pasteAsPath } from "../src/Input";
import { detectPreviewMode, emitImage, imageChip } from "../src/image-preview";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pasteAsPath (pure)", () => {
  const isFile = (p: string) => p === "shot.png" || p === "my shot.png";
  test("converts a bare existing path", () => {
    expect(pasteAsPath("shot.png", isFile)).toBe("shot.png");
  });
  test("strips shell quotes and keeps spaced paths", () => {
    expect(pasteAsPath('"/tmp/my shot.png"', () => true)).toBe("/tmp/my shot.png");
    expect(pasteAsPath("'/tmp/a.png'", () => true)).toBe("/tmp/a.png");
  });
  test("non-paths and multiline pastes stay verbatim (null)", () => {
    expect(pasteAsPath("hello world", isFile)).toBeNull();
    expect(pasteAsPath("line one\nline two", isFile)).toBeNull();
    expect(pasteAsPath("", isFile)).toBeNull();
    expect(pasteAsPath("missing.png", isFile)).toBeNull();
  });
});

describe("detectPreviewMode", () => {
  test("auto: kitty/ghostty env wins, then iTerm2 family, unknown falls back", () => {
    expect(detectPreviewMode({ KITTY_WINDOW_ID: "1" }, "auto")).toEqual({ protocol: "kitty" });
    expect(detectPreviewMode({ GHOSTTY_RESOURCES_DIR: "/x" }, "auto")).toEqual({ protocol: "kitty" });
    expect(detectPreviewMode({ TERM_PROGRAM: "iTerm.app" }, "auto")).toEqual({ protocol: "iterm2" });
    expect(detectPreviewMode({ TERM_PROGRAM: "WezTerm" }, "auto")).toEqual({ protocol: "iterm2" });
    expect(detectPreviewMode({}, "auto")).toEqual({ protocol: "none" });
    expect(detectPreviewMode({ TERM_PROGRAM: "Apple_Terminal" }, "auto")).toEqual({ protocol: "none" });
  });
  test("off suppresses even supported environments; on opts in anywhere", () => {
    expect(detectPreviewMode({ KITTY_WINDOW_ID: "1" }, "off")).toEqual({ protocol: "none" });
    expect(detectPreviewMode({ TERM_PROGRAM: "Apple_Terminal" }, "on")).toEqual({ protocol: "iterm2" });
  });
});

describe("emitImage + chip", () => {
  const cell = { columns: 80, rows: 24, cellWidth: 0, cellHeight: 0 };
  const image = { name: "shot.png", mime: "image/png", base64: "QUJD" };
  test("none emits nothing", () => {
    expect(emitImage(image, { protocol: "none" }, cell, 1)).toBeNull();
  });
  test("kitty emits a placement-tagged graphics apc sequence", () => {
    const seq = emitImage(image, { protocol: "kitty" }, cell, 7)!;
    expect(seq).toContain("\x1b_Gf=1,a=T,p=7");
    expect(seq).toContain("QUJD");
    expect(seq.endsWith("\x1b\\")).toBe(true);
  });
  test("iterm2 emits an OSC 1337 inline file", () => {
    const seq = emitImage(image, { protocol: "iterm2" }, cell, 1)!;
    expect(seq).toContain("\x1b]1337;File=");
    expect(seq).toContain("inline=1");
    expect(seq.endsWith("\x07")).toBe(true);
  });
  test("oversized payloads chunk with kitty m=1 continuation", () => {
    const big = { ...image, base64: "A".repeat(9000) };
    const seq = emitImage(big, { protocol: "kitty" }, cell, 3)!;
    expect(seq).toContain("m=1,");
    expect(seq.match(/\x1b_G/g)?.length).toBeGreaterThan(1);
  });
  test("chip carries name and dimensions", () => {
    expect(imageChip({ name: "a.png", width: 10, height: 20 })).toBe("[image: a.png 10x20]");
    expect(imageChip({ name: "a.png" })).toBe("[image: a.png]");
  });
});

describe("paste → mention (component)", () => {
  test("a bracketed paste of an existing path inserts @path and submits it", async () => {
    let sent = "";
    const i = render(
      <MultilineInput
        placeholder="p"
        focused
        onPastePath={(p) => pasteAsPath(p, (x) => x === "shot.png")}
        onSubmit={(text) => { sent = text; }}
      />,
    );
    await sleep(30);
    i.stdin.write("\x1b[200~shot.png\x1b[201~");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(sent).toBe("@shot.png");
    i.unmount();
  });

  test("a paste that is not a path inserts verbatim", async () => {
    let sent = "";
    const i = render(
      <MultilineInput
        placeholder="p"
        focused
        onPastePath={(p) => pasteAsPath(p, () => false)}
        onSubmit={(text) => { sent = text; }}
      />,
    );
    await sleep(30);
    i.stdin.write("\x1b[200~hello there\x1b[201~");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(sent).toBe("hello there");
    i.unmount();
  });
});
