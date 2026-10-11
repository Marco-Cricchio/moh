import "./faketty/ci-mask";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import React from "react";
import { Box, Text } from "ink";
import { blockTint, TranscriptBlockView, type TranscriptBlock } from "../src/transcript";
import { ThemeProvider, THEMES } from "../src/themes";
import { renderOnFakeTty } from "./faketty/render";

const chalk = createRequire(import.meta.resolve("ink"))("chalk").default as { level: 0 | 1 | 2 | 3 };
const width = 44;
const theme = THEMES["tokyo-night"];
const marker = "END-OF-BLOCK";
type Cell = { text: string; bg?: string };

// VtScreen consumes SGR without recording colors. These single-frame tests
// additionally decode the actual painted cells, including explicit spaces.
function backgroundCells(bytes: string): Cell[][] {
  const rows: Cell[][] = [[]];
  let y = 0, x = 0;
  let bg: string | undefined;
  const row = () => rows[y] ?? (rows[y] = []);
  for (const token of bytes.matchAll(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07)|[^\x1b]/gu)) {
    const value = token[0];
    if (value.startsWith("\x1b[")) {
      const command = value.at(-1);
      const args = value.slice(2, -1).split(";").map(Number);
      if (command === "m") {
        for (let i = 0; i < args.length; i++) {
          const code = args[i];
          if (code === 0 || code === 49) bg = undefined;
          else if (code === 48 && args[i + 1] === 2) {
            bg = `#${args.slice(i + 2, i + 5).map((n) => n.toString(16).padStart(2, "0")).join("")}`;
            i += 4;
          } else if ((code === 38 || code === 48) && args[i + 1] === 5) i += 2;
          else if (code === 38 && args[i + 1] === 2) i += 4;
        }
      } else if (command === "G") x = (args[0] || 1) - 1;
      else if (command === "A") y = Math.max(0, y - (args[0] || 1));
      else if (command === "B") y += args[0] || 1;
      else if (command === "C") x += args[0] || 1;
      else if (command === "D") x = Math.max(0, x - (args[0] || 1));
      else if (command === "H" || command === "f") { y = (args[0] || 1) - 1; x = (args[1] || 1) - 1; }
      else if (command === "K") {
        if (args[0] === 2) rows[y] = [];
        else row().splice(x);
      } else if (command === "J" && (args[0] === 2 || args[0] === 3)) { rows.length = 0; }
      continue;
    }
    if (value.startsWith("\x1b")) continue;
    if (value === "\n") { y++; x = 0; continue; }
    if (value === "\r") { x = 0; continue; }
    if (value < " ") continue;
    const cells = Bun.stringWidth(value);
    for (let i = 0; i < cells; i++) row()[x++] = { text: i === 0 ? value : "", bg };
  }
  return rows;
}

const textOf = (row: Cell[]) => Array.from(row, (cell) => cell?.text ?? " ").join("");
const block = (overrides: Partial<TranscriptBlock> = {}): TranscriptBlock => ({
  key: "surface", kind: "tool", glyph: "✓", type: "bash", state: "ok", lines: ["output"], ...overrides,
});

let previousLevel: typeof chalk.level;
let previousNoColor: string | undefined;
beforeEach(() => {
  previousLevel = chalk.level;
  previousNoColor = process.env.NO_COLOR;
  chalk.level = 3;
  delete process.env.NO_COLOR;
});
afterEach(() => {
  chalk.level = previousLevel;
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;
});

async function renderBlock(value: TranscriptBlock, liveMeta?: { elapsedMs: number; timeoutMs?: number }) {
  const term = renderOnFakeTty(<ThemeProvider value={theme}><Box flexDirection="column">
    <TranscriptBlockView block={value} width={width} liveMeta={liveMeta} />
    <Text>{marker}</Text>
  </Box></ThemeProvider>, { cols: width, rows: 24 });
  try {
    await term.settle();
    const bytes = term.rawBytes().toString();
    const cells = backgroundCells(bytes);
    const end = cells.findIndex((row) => textOf(row).includes(marker));
    expect(bytes).not.toContain("ERROR");
    expect(end).toBeGreaterThanOrEqual(0);
    return { bytes, rows: cells.slice(0, end) };
  } finally { await term.unmount(); }
}

function expectTinted(rows: Cell[][], value: TranscriptBlock) {
  const tint = blockTint(value, theme);
  expect(tint).toBeDefined();
  for (const row of rows) {
    // Check every cell, not just glyphs or an SGR somewhere in the row.
    expect(Array.from({ length: width }, (_, col) => row[col]?.bg)).toEqual(Array(width).fill(tint));
  }
}

function expectNeutral(rows: Cell[][]) {
  for (const row of rows) expect(row.filter((cell) => cell?.bg !== undefined)).toEqual([]);
}

describe("#1305 continuous transcript block surfaces", () => {
  for (const kind of ["tool", "diff", "code", "error", "subagent"] as const) {
    test(`${kind}: lead-in, head, indented body and closing gap tint every cell`, async () => {
      const value = block({ kind });
      const { rows } = await renderBlock(value);
      expectTinted(rows, value);
      expect(rows.map((row) => textOf(row).trim())).toEqual(["", "✓ bash", "output", ""]);
    });
  }

  test("moh markdown paints all cells, including indentation and the last column", async () => {
    const value = block({ kind: "moh", glyph: "◆", type: "moh", state: undefined, lines: [], markdown: "## Plan\n\nA short paragraph.\n\n- first item" });
    const { rows } = await renderBlock(value);
    expectTinted(rows, value);
    expect(textOf(rows[0]!).trim()).toBe("");
    expect(textOf(rows.at(-1)!).trim()).toBe("");
    expect(rows.some((row) => textOf(row).includes("Plan"))).toBe(true);
    expect(rows.some((row) => textOf(row).includes("A short paragraph."))).toBe(true);
    expect(rows.some((row) => textOf(row).includes("first item"))).toBe(true);
  });

  test("a six-cell-indented bullet has no background holes", async () => {
    const value = block({ lines: ["• item"], lineKinds: ["bullet"] });
    const { rows } = await renderBlock(value);
    expectTinted(rows, value);
    expect(textOf(rows[2]!).startsWith("      • item")).toBe(true);
    expect(rows).toHaveLength(4);
  });

  test("running timer renders without Box-in-Text errors and shares one fully tinted head row", async () => {
    const value = block({ state: "run", glyph: "◌", detail: "bun test" });
    const { rows } = await renderBlock(value, { elapsedMs: 2000, timeoutMs: 30000 });
    expectTinted(rows, value);
    expect(rows).toHaveLength(4);
    const heads = rows.filter((row) => textOf(row).includes("bash"));
    expect(heads).toHaveLength(1);
    expect(textOf(heads[0]!)).toContain("◌ bash bun test");
    expect(textOf(heads[0]!)).toContain("⏱ 2s · 30s");
  });

  test("thinking is neutral and has neither lead-in nor closing gaps", async () => {
    const { bytes, rows } = await renderBlock(block({ kind: "thinking", glyph: "◇", type: "thinking", state: undefined, lines: ["reasoning text"] }));
    expectNeutral(rows);
    expect(bytes).not.toContain("48;2");
    expect(rows.map((row) => textOf(row).trim())).toEqual(["◇ thinking", "reasoning text"]);
  });

  for (const markdown of [false, true]) {
    test(`tight continuation (${markdown ? "markdown" : "lines"}) paints its body without head or gaps`, async () => {
      const value = block({ kind: "moh", continuation: true, tight: true, lines: ["continued"], ...(markdown ? { renderedMarkdownRows: ["continued"] } : {}) });
      const { rows } = await renderBlock(value);
      expectTinted(rows, value);
      expect(rows.map((row) => textOf(row).trim())).toEqual(["continued"]);
    });
  }

  test("NO_COLOR removes gaps and preserves width-minus-one rows", async () => {
    process.env.NO_COLOR = "1";
    const value = block({ glyph: "x", type: "h".repeat(width - 3), lines: ["output"] });
    const { bytes, rows } = await renderBlock(value);
    expectNeutral(rows);
    expect(bytes).not.toMatch(/\x1b\[(?:38|48);/);
    expect(rows.map((row) => textOf(row).trim())).toEqual([`x ${value.type}`, "output"]);
    expect(rows[0]).toHaveLength(width - 1);
    expect(rows.every((row) => row[width - 1] === undefined)).toBe(true);
  });

  test("user retains its bare lead-in and untinted bordered frame without a closing gap", async () => {
    const { rows } = await renderBlock(block({ kind: "user", glyph: "❯", type: "you", state: undefined, lines: ["hello"] }));
    expectNeutral(rows);
    expect(rows.map((row) => textOf(row).trim())).toEqual([
      "", `┏${"━".repeat(width - 4)}┓`,
      `┃ ❯ you${" ".repeat(width - 10)}┃`,
      `┃ hello${" ".repeat(width - 10)}┃`,
      `┗${"━".repeat(width - 4)}┛`,
    ]);
  });
});
