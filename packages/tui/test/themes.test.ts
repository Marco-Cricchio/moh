import { describe, expect, it } from "bun:test";
import { THEMES, THEME_ORDER, type Theme } from "../src/themes";

describe("themes catalog (issue #114)", () => {
  it("offers the curated catalog in THEME_ORDER", () => {
    expect(THEME_ORDER).toEqual([
      "tokyo-night", "catppuccin", "gruvbox-material", "phosphor",
      "phosphor-amber", "neon-noir", "lava", "candy",
      "commodore64", "amiga-workbench13", "iron-man", "star-wars",
      "daylight", "daylight-frost", "tron", "blade-runner",
      "vaporwave", "pop-art",
    ]);
  });

  it("every theme defines the full semantic token set (fg..bg + surface tokens, #749)", () => {
    const tokens: (keyof Theme)[] = ["label", "fg", "accent", "dim", "ok", "warn", "err", "purple", "border", "bg", "surface", "surfaceRaised", "selection"];
    for (const name of THEME_ORDER) {
      for (const token of tokens) expect(THEMES[name][token], `${name}.${token}`).toBeTruthy();
    }
  });

  it("error token is distinct from warning", () => {
    for (const name of THEME_ORDER) expect(THEMES[name].err).not.toBe(THEMES[name].warn);
  });
});
