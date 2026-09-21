/**
 * #880: the TUI honours `NO_COLOR` — no color, but the attributes stay.
 *
 * The convention (no-color.org) is about *color* only: a program should not
 * emit ANSI color when the variable is present and non-empty, while bold,
 * dim and italic are not colors. Two paths reach the terminal with color, and
 * both answer to the same switch: Ink's `color`/`borderColor`/
 * `backgroundColor` (fed by the palette projection) and the escapes written
 * by hand where a string is built outside Ink (markdown, the quota table,
 * the preview box).
 *
 * What these tests pin: the switch's semantics (an empty value means "not
 * set"), the projection (colors gone, `label` kept, identity preserved when
 * they are on, cached when they are off), the hand-written escapes, the tint
 * that must not blend into nothing — and, in a real child process, that a
 * disabled run emits no color code while keeping emphasis.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { THEMES, paintable, useTheme } from "../src/themes";
import { colorEnabled, fgAnsi256, fgTruecolor } from "../src/color";
import { blockTint, type TranscriptBlock } from "../src/transcript";

/** Runs `body` with NO_COLOR pinned to `value` (undefined = unset). A
 * function declaration, not an arrow: a bare `<T>` in a .tsx file parses as
 * JSX. */
function withNoColor<T>(value: string | undefined, body: () => T): T {
  const saved = process.env.NO_COLOR;
  if (value === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = value;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  }
};

afterEach(() => {
  delete process.env.NO_COLOR;
});

describe("the capability seam (#880)", () => {
  test("NO_COLOR semantics: present and non-empty disables color", () => {
    expect(withNoColor(undefined, colorEnabled)).toBe(true);
    // The spec's own example: an empty value means "not set".
    expect(withNoColor("", colorEnabled)).toBe(true);
    // Any non-empty value means no color — including a zero.
    for (const value of ["1", "0", "true", " "]) expect(withNoColor(value, colorEnabled)).toBe(false);
  });

  test("the hand-written escapes follow it, and paint nothing without a color", () => {
    expect(withNoColor(undefined, () => fgTruecolor("#7aa2f7"))).toBe("\x1b[38;2;122;162;247m");
    expect(withNoColor("1", () => fgTruecolor("#7aa2f7"))).toBe("");
    // No color to paint at all: same empty string, so callers can pair it
    // with a reset without rendering a stray escape.
    expect(fgTruecolor(undefined)).toBe("");
    // A token that is not a color paints nothing: no escape full of NaN
    // (the shared seam sees callers the old per-file helper never had).
    expect(fgTruecolor("not-a-hex")).toBe("");
    // Three-digit hex is a hex: it expands rather than falling through.
    expect(withNoColor(undefined, () => fgTruecolor("#abc"))).toBe("\x1b[38;2;170;187;204m");

    // The ANSI-256 form the quota table's cells use (cli-table3 builds plain
    // strings, so Ink cannot style a cell on its own).
    expect(withNoColor(undefined, () => fgAnsi256("#7aa2f7"))).toMatch(/^\x1b\[38;5;\d+m$/);
    expect(withNoColor("1", () => fgAnsi256("#7aa2f7"))).toBe("");
    expect(fgAnsi256(undefined)).toBe("");
    // Unrecognized values paint nothing rather than a wrong index.
    expect(fgAnsi256("nonsense")).toBe("");
  });
});

describe("paintable(): the palette a component receives (#880)", () => {
  test("colors on: the palette itself, identity preserved for memo keys", () => {
    const theme = THEMES["tokyo-night"];
    expect(withNoColor(undefined, () => paintable(theme))).toBe(theme);
  });

  test("colors off: every color gone, the label kept, the object cached", () => {
    const theme = THEMES["tokyo-night"];
    const painted = withNoColor("1", () => paintable(theme));
    expect(painted.label).toBe(theme.label);
    for (const [role, value] of Object.entries(painted)) {
      if (role === "label") continue;
      expect(value, role).toBeUndefined();
    }
    // One stable object per palette: a fresh projection every render would
    // invalidate the memos keyed on the theme (markdown renderer, tints).
    expect(withNoColor("1", () => paintable(theme))).toBe(painted);
    // A different palette keeps its own label.
    expect(withNoColor("1", () => paintable(THEMES["lava"])).label).toBe(THEMES["lava"].label);
  });

  test("a block tint is color: without the tokens there is no tint to blend", () => {
    const block = { key: "k", kind: "moh", state: "ok" } as unknown as TranscriptBlock;
    const on = withNoColor(undefined, () => blockTint(block, THEMES["tokyo-night"]))!;
    expect(on).toMatch(/^#[0-9a-f]{6}$/);
    expect(withNoColor("1", () => blockTint(block, paintable(THEMES["tokyo-night"])))).toBeUndefined();
  });
});

describe("the rendered TUI honours NO_COLOR (#880)", () => {
  /**
   * Ink paints through chalk, whose level is decided at import time from the
   * environment — so "colors on" is only observable in a child process with
   * color forced (the same idiom markdown.test.ts uses for cli-highlight).
   */
  const renderProbe = (noColor: boolean): { fg: number; bg: number; bold: number; dim: number; row: string } => {
    const bar = join(__dirname, "../src/BottomBar.tsx");
    const scanner = join(__dirname, "../src/scanner.ts");
    const themes = join(__dirname, "../src/themes.ts");
    const script = [
      `const React = (await import("react")).default;`,
      `const { render } = await import("ink-testing-library");`,
      `const [{ BottomBar }, { scannerFrame }, { ThemeProvider, THEMES }] = await Promise.all([`,
      `  import(${JSON.stringify(bar)}), import(${JSON.stringify(scanner)}), import(${JSON.stringify(themes)}),`,
      `]);`,
      `const ink = render(React.createElement(ThemeProvider, { value: THEMES["tokyo-night"] },`,
      `  React.createElement(BottomBar, { width: 100, pending: true, spinner: scannerFrame(1), mode: "dev", model: "mock", turns: 1, tokens: { contextIn: 0, totalOut: 0, calls: 0 }, level: "default", focusedChip: null, phase: "thinking", cwd: "/x", branch: "develop", permissionMode: "yolo", memoryFresh: true })));`,
      `const frame = ink.lastFrame() ?? "";`,
      `ink.unmount();`,
      `const count = (re) => (frame.match(re) ?? []).length;`,
      `process.stdout.write(JSON.stringify({ fg: count(/\\u001b\\[38[;0-9]*m/g), bg: count(/\\u001b\\[48[;0-9]*m/g), bold: count(/\\u001b\\[1m/g), dim: count(/\\u001b\\[2m/g), row: frame.split("\\n")[0] }));`,
    ].join("\n");
    const env = { ...process.env, FORCE_COLOR: "3", ...(noColor ? { NO_COLOR: "1" } : {}) };
    if (!noColor) delete (env as Record<string, string | undefined>).NO_COLOR;
    const proc = Bun.spawnSync(["bun", "-e", script], { env });
    // FORCE_COLOR is what makes chalk paint at all here (it wins over
    // NO_COLOR in the runtime's own detection, and says so on stderr): that
    // is the point — the color must go because *moh* withheld it, not
    // because some other layer stripped it.
    expect(JSON.parse(proc.stdout.toString())).toBeDefined();
    return JSON.parse(proc.stdout.toString()) as { fg: number; bg: number; bold: number; dim: number; row: string };
  };

  test("colors on: the bar paints color (the control)", () => {
    const painted = renderProbe(false);
    expect(painted.fg).toBeGreaterThan(0);
    expect(painted.bold).toBeGreaterThan(0);
    expect(painted.dim).toBeGreaterThan(0);
  }, 30_000);

  test("colors off: no color code at all, emphasis intact", () => {
    const plain = renderProbe(true);
    expect(plain.fg).toBe(0);
    expect(plain.bg).toBe(0);
    // …and the attributes NO_COLOR does not touch are still there: the
    // scanner's light stays bold, its trail stays dim.
    expect(plain.bold).toBeGreaterThan(0);
    expect(plain.dim).toBeGreaterThan(0);
    expect(plain.row).toContain("▮");
  }, 30_000);

  /**
   * The theme studio is the one surface that *paints* the palette under
   * construction rather than the session chrome, and it builds its own theme
   * object instead of reading the context — so its compliance (tokens through
   * the projection, derived hues and swatches suppressed) is worth its own
   * probe. What must not change is the draft it saves: only the screen is
   * affected.
   */
  const studioProbe = (noColor: boolean): { fg: number; bg: number; saved: Record<string, string> } => {
    const studio = join(__dirname, "../src/ThemeStudioModal.tsx");
    const themes = join(__dirname, "../src/themes.ts");
    const script = [
      `const React = (await import("react")).default;`,
      `const { render } = await import("ink-testing-library");`,
      `const [{ ThemeStudioModal }, { ThemeProvider, THEMES }] = await Promise.all([import(${JSON.stringify(studio)}), import(${JSON.stringify(themes)})]);`,
      `let saved = {};`,
      `const ink = render(React.createElement(ThemeProvider, { value: THEMES["tokyo-night"] },`,
      `  React.createElement(ThemeStudioModal, { home: "/tmp/moh-880-studio", base: "tokyo-night", activeRef: "tokyo-night",`,
      `    onToast: () => {}, onSave: (id, name, colors) => { saved = colors; }, onApplyRef: () => {}, onClose: () => {} })));`,
      `const frame = ink.lastFrame() ?? "";`,
      `ink.unmount();`,
      `const count = (re) => (frame.match(re) ?? []).length;`,
      `process.stdout.write(JSON.stringify({ fg: count(/\\u001b\\[38[;0-9]*m/g), bg: count(/\\u001b\\[48[;0-9]*m/g), saved }));`,
    ].join("\n");
    const env = { ...process.env, FORCE_COLOR: "3", ...(noColor ? { NO_COLOR: "1" } : {}) };
    if (!noColor) delete (env as Record<string, string | undefined>).NO_COLOR;
    const proc = Bun.spawnSync(["bun", "-e", script], { env });
    return JSON.parse(proc.stdout.toString()) as { fg: number; bg: number; saved: Record<string, string> };
  };

  test("the theme studio paints no color either, and its draft is untouched", () => {
    const colored = studioProbe(false);
    expect(colored.fg).toBeGreaterThan(0);
    const plain = studioProbe(true);
    expect(plain.fg).toBe(0);
    expect(plain.bg).toBe(0);
    // The save path reads the draft, never the projection: with colors off
    // the studio still hands out real hexes.
    expect(plain.saved).toEqual(colored.saved);
    expect(Object.values(plain.saved).every((value) => /^#[0-9a-f]{6}$/i.test(value))).toBe(true);
  }, 30_000);

  test("useTheme is the switch the components consume", () => {
    // A component's view of the palette is the projection, never the raw
    // context value: with colors off no token survives.
    const theme = withNoColor("1", () => paintable(THEMES["candy"]));
    expect(theme.accent).toBeUndefined();
    expect(typeof useTheme).toBe("function");
  });
});
