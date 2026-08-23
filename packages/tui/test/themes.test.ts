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
  it("offers 15 themes in THEME_ORDER", () => {
    expect(THEME_ORDER.length).toBe(15);
    expect(THEME_ORDER).toContain("win95");
    expect(THEME_ORDER).toContain("dos");
    expect(THEME_ORDER).toContain("mac-platinum");
    expect(THEME_ORDER).toContain("neon-noir");
    expect(THEME_ORDER).toContain("lava");
    expect(THEME_ORDER).toContain("candy");
  });

  it("every theme defines the full semantic token set (fg..bg)", () => {
    const tokens: (keyof Theme)[] = ["label", "fg", "accent", "dim", "ok", "warn", "purple", "border", "bg"];
    for (const name of THEME_ORDER) {
      for (const token of tokens) expect(THEMES[name][token], `${name}.${token}`).toBeTruthy();
    }
  });

  it("mac-platinum: dim and border readable on the light background", () => {
    const t = THEMES["mac-platinum"];
    expect(contrast(t.fg, t.bg)).toBeGreaterThanOrEqual(7); // black on #dddddd
    expect(contrast(t.dim, t.bg)).toBeGreaterThanOrEqual(4); // audited dim
    expect(contrast(t.border, t.bg)).toBeGreaterThanOrEqual(2.5); // visible chrome
    expect(contrast(t.accent, t.bg)).toBeGreaterThanOrEqual(4); // amber accent
  });
});
