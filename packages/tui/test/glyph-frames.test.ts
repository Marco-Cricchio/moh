import { describe, expect, test } from "bun:test";
import { GROW_VERTICAL_FRAMES, SAND_FRAMES, SPINNER_FRAMES, frameGlyph, setIcons } from "../src/icons";
import { GLYPH_ERR, GLYPH_OK, glyphColor } from "../src/glyph-color";

describe("semantic glyph colors (#1300)", () => {
  test("glyphColor maps ✓/✗ to the fixed hexes, everything else to undefined", () => {
    expect(glyphColor("✓")).toBe(GLYPH_OK);
    expect(glyphColor("✗")).toBe(GLYPH_ERR);
    expect(GLYPH_OK).toBe("#2ea043");
    expect(GLYPH_ERR).toBe("#ee5a52");
    expect(glyphColor("◌")).toBeUndefined();
    expect(glyphColor("◇")).toBeUndefined();
    expect(glyphColor("✓ done")).toBe(GLYPH_OK);
  });

  test("the fixed hexes differ from the ok/err tokens of the off-hue themes", () => {
    // The regression this seam exists for: on TRON `ok` is cyan, on Lava it is amber.
    const { THEMES } = require("../src/themes") as { THEMES: Record<string, { ok: string; err: string }> };
    for (const name of ["tron", "lava", "iron-man", "amber-phosphor"]) {
      const theme = THEMES[name];
      if (!theme) continue;
      expect(theme.ok).not.toBe(GLYPH_OK);
    }
  });
});

describe("subagent activity frames (#1300)", () => {
  test("frame data: sand 35 frames, growVertical 10 frames, spinner set untouched", () => {
    expect(SAND_FRAMES.length).toBe(35);
    expect(GROW_VERTICAL_FRAMES.length).toBe(10);
    expect(SPINNER_FRAMES.length).toBe(10);
  });

  test("only a running member cycles; ⏸ and settled glyphs are static", () => {
    for (let frame = 0; frame < 40; frame++) {
      expect(frameGlyph("◐", frame, SAND_FRAMES)).toBe(SAND_FRAMES[frame % SAND_FRAMES.length]);
      expect(frameGlyph("⏸", frame, SAND_FRAMES)).toBe("⏸");
      expect(frameGlyph("✓", frame, SAND_FRAMES)).toBe("✓");
      expect(frameGlyph("✗", frame, SAND_FRAMES)).toBe("✗");
      expect(frameGlyph("", frame, SAND_FRAMES)).toBe("");
    }
  });

  test("the frame index wraps", () => {
    expect(frameGlyph("◐", SAND_FRAMES.length, SAND_FRAMES)).toBe(SAND_FRAMES[0]);
    expect(frameGlyph("◐", GROW_VERTICAL_FRAMES.length + 3, GROW_VERTICAL_FRAMES)).toBe(GROW_VERTICAL_FRAMES[3]);
  });

  test("Icons off: the running glyph becomes a static ASCII dash", () => {
    setIcons(false);
    try {
      expect(frameGlyph("◐", 5, SAND_FRAMES)).toBe("-");
    } finally {
      setIcons(true);
    }
    expect(frameGlyph("◐", 5, SAND_FRAMES)).toBe(SAND_FRAMES[5]);
  });
});
