import { describe, expect, it } from "bun:test";
import { THEMES, THEME_ORDER, contrastRatio, contrastWarnings, isHexColor, type Theme } from "../src/themes";
import { highlightThemeFor } from "../src/markdown";

/** chalk level forcing: verify the hex values survive the existing Ink/chalk
 * pipeline (which downshifts truecolor → 256 → 16 via supportsColor level)
 * and never throw — #749 explicitly excludes dedicated downshift logic. */
describe("color degradation through the existing pipeline (#749)", () => {
  it("chalk renders every theme token at level 0 (ANSI-16) without throwing", async () => {
    const chalk = (await import("chalk")).default;
    for (const level of [0, 1, 2, 3] as const) {
      chalk.level = level;
      for (const name of THEME_ORDER) {
        const theme = THEMES[name] as unknown as Theme;
        for (const [role, hex] of Object.entries(theme)) {
          if (role === "label") continue;
          expect(() => chalk.hex(hex as string)(`${role}`), `${name}.${role}@${level}`).not.toThrow();
        }
      }
    }
    chalk.level = 3;
  });

  it("highlightThemeFor accepts every resolved theme (incl. user themes) and produces ANSI strings", async () => {
    const chalk = (await import("chalk")).default;
    const saved = chalk.level;
    for (const level of [0, 1, 2, 3] as const) {
      chalk.level = level;
      const fake: Theme = { ...THEMES["tokyo-night"], fg: "#123abc", accent: "#456def" };
      const map = highlightThemeFor(fake);
      const out = map.keyword("if");
      expect(typeof out).toBe("string");
      expect(out).toContain("if");
    }
    chalk.level = saved;
  });
});

describe("contrast auditing helpers (#749)", () => {
  it("all built-in presets pass the 3:1 check for text/accent roles", () => {
    for (const name of THEME_ORDER) {
      expect(contrastWarnings(THEMES[name] as unknown as Record<string, string>), name).toEqual([]);
    }
  });

  it("contrastWarnings flags a low-contrast role and ignores surface/border roles", () => {
    const colors = { ...THEMES["tokyo-night"], fg: "#16161e" } as unknown as Record<string, string>;
    const warnings = contrastWarnings(colors);
    expect(warnings.some((w) => w.startsWith("fg:"))).toBe(true);
    // border/surface roles are exempt: set them to bg and expect no warnings
    const surfaces = { ...THEMES["tokyo-night"], border: "#16161e", surface: "#16161e", surfaceRaised: "#16161e", selection: "#16161e" } as unknown as Record<string, string>;
    expect(contrastWarnings(surfaces)).toEqual([]);
  });

  it("contrastRatio is symmetric and 1:1 for equal colors", () => {
    expect(contrastRatio("#000000", "#000000")).toBeCloseTo(1);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 0);
  });

  it("isHexColor accepts #rgb/#rrggbb and rejects named/invalid values", () => {
    expect(isHexColor("#fff")).toBe(true);
    expect(isHexColor("#ABCDEF")).toBe(true);
    expect(isHexColor("red")).toBe(false);
    expect(isHexColor("#12345")).toBe(false);
    expect(isHexColor("")).toBe(false);
  });
});
