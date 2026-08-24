import { describe, expect, it } from "bun:test";
import { THEMES, THEME_ORDER, type Theme } from "../src/themes";

/** WCAG relative luminance + contrast ratio for contrast auditing. */
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}

describe("themes catalog (issue #114)", () => {
  it("offers the curated eight themes in THEME_ORDER", () => {
    expect(THEME_ORDER).toEqual([
      "tokyo-night", "catppuccin", "gruvbox-material", "phosphor",
      "phosphor-amber", "neon-noir", "lava", "candy",
    ]);
  });

  it("every theme defines the full semantic token set (fg..bg)", () => {
    const tokens: (keyof Theme)[] = ["label", "fg", "accent", "dim", "ok", "warn", "err", "purple", "border", "bg"];
    for (const name of THEME_ORDER) {
      for (const token of tokens) expect(THEMES[name][token], `${name}.${token}`).toBeTruthy();
    }
  });

  it("error token is distinct from warning", () => {
    for (const name of THEME_ORDER) expect(THEMES[name].err).not.toBe(THEMES[name].warn);
  });
});
