import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listUserThemes,
  loadUserTheme,
  parseUserThemeFile,
  saveUserTheme,
  deleteUserTheme,
  themesDir,
  resolveThemeRef,
  type UserThemeFile,
} from "../src/user-themes";
import { DEFAULT_THEME, THEMES } from "../src/themes";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-themes-"));
}

const validTheme: UserThemeFile = {
  version: 1,
  id: "my-violet",
  name: "My Violet",
  extends: "tokyo-night",
  colors: { accent: "#B983FF", fg: "#EDEAF4" },
};

describe("user themes (#749)", () => {
  it("themesDir points at ~/.moh/themes", () => {
    expect(themesDir("/home/u")).toBe(join("/home/u", ".moh", "themes"));
  });

  describe("parseUserThemeFile", () => {
    it("accepts a valid theme", () => {
      const parsed = parseUserThemeFile("my-violet.json", JSON.stringify(validTheme));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.theme.id).toBe("my-violet");
    });

    it("rejects invalid JSON with the file path", () => {
      const parsed = parseUserThemeFile("broken.json", "{nope");
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("broken.json");
    });

    it("rejects a non-object root", () => {
      const parsed = parseUserThemeFile("x.json", "[1]");
      expect(parsed.ok).toBe(false);
    });

    it("rejects version !== 1", () => {
      const parsed = parseUserThemeFile("x.json", JSON.stringify({ ...validTheme, version: 2 }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("version");
    });

    it("rejects an invalid id slug", () => {
      const parsed = parseUserThemeFile("x.json", JSON.stringify({ ...validTheme, id: "My Violet!" }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("id");
    });

    it("rejects a missing name", () => {
      const { name: _drop, ...noName } = validTheme;
      const parsed = parseUserThemeFile("x.json", JSON.stringify(noName));
      expect(parsed.ok).toBe(false);
    });

    it("rejects extends pointing at another user theme id", () => {
      const parsed = parseUserThemeFile("x.json", JSON.stringify({ ...validTheme, extends: "other-user-theme" }));
      expect(parsed.ok).toBe(false);
    });

    it("rejects an unknown color role", () => {
      const parsed = parseUserThemeFile("x.json", JSON.stringify({ ...validTheme, colors: { text: "#ffffff" } }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("text");
    });

    it("rejects a non-hex color value", () => {
      const parsed = parseUserThemeFile("x.json", JSON.stringify({ ...validTheme, colors: { accent: "violet" } }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("accent");
    });
  });

  describe("loadUserTheme", () => {
    it("resolves colors over the extends base and keeps the file label", () => {
      const home = makeHome();
      try {
        const dir = themesDir(home);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "my-violet.json"), JSON.stringify(validTheme));
        const theme = loadUserTheme(home, "my-violet");
        expect(theme).not.toBeNull();
        expect(theme!.label).toBe("My Violet");
        expect(theme!.accent).toBe("#b983ff");
        // inherited from tokyo-night
        expect(theme!.bg).toBe(THEMES["tokyo-night"].bg);
        expect(theme!.dim).toBe(THEMES["tokyo-night"].dim);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("returns null for a missing theme", () => {
      const home = makeHome();
      try {
        expect(loadUserTheme(home, "nope")).toBeNull();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("returns null for an unreadable/malformed theme", () => {
      const home = makeHome();
      try {
        const dir = themesDir(home);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "bad.json"), "{nope");
        expect(loadUserTheme(home, "bad")).toBeNull();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("listUserThemes", () => {
    it("lists valid themes with id and name, skipping invalid ones", () => {
      const home = makeHome();
      try {
        const dir = themesDir(home);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "my-violet.json"), JSON.stringify(validTheme));
        writeFileSync(join(dir, "bad.json"), "{nope");
        const list = listUserThemes(home);
        expect(list).toEqual([{ id: "my-violet", name: "My Violet" }]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("returns an empty list without the directory", () => {
      const home = makeHome();
      try {
        expect(listUserThemes(home)).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("saveUserTheme / deleteUserTheme", () => {
    it("saves atomically and rejects a duplicate id with a different file name", () => {
      const home = makeHome();
      try {
        saveUserTheme(home, validTheme);
        // Same id, same file — the legitimate edit path must succeed and
        // apply the new colors.
        saveUserTheme(home, { ...validTheme, colors: { accent: "#FF00FF" } });
        expect(loadUserTheme(home, "my-violet")!.accent).toBe("#ff00ff");
        // A file whose internal id doesn't match its file name blocks the
        // save of the id its name claims — never silently clobber.
        const dir = themesDir(home);
        const mismatched = { ...validTheme, id: "squatter" };
        writeFileSync(join(dir, "other.json"), JSON.stringify(mismatched));
        expect(() => saveUserTheme(home, { ...validTheme, id: "other" })).toThrow(/already holds/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("overwrites the same id on save (edit path)", () => {
      const home = makeHome();
      try {
        saveUserTheme(home, validTheme);
        saveUserTheme(home, { ...validTheme, colors: { accent: "#FF00FF" } });
        expect(loadUserTheme(home, "my-violet")!.accent).toBe("#ff00ff");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("deleteUserTheme reports whether the file existed", () => {
      const home = makeHome();
      try {
        saveUserTheme(home, validTheme);
        expect(deleteUserTheme(home, "my-violet")).toBe(true);
        expect(deleteUserTheme(home, "my-violet")).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("resolveThemeRef", () => {
    it("resolves a built-in preset id", () => {
      const result = resolveThemeRef("/nonexistent", "tokyo-night");
      expect(result.theme).toBe(THEMES["tokyo-night"]);
      expect(result.error).toBeUndefined();
    });

    it("resolves user:<id>", () => {
      const home = makeHome();
      try {
        saveUserTheme(home, validTheme);
        const result = resolveThemeRef(home, "user:my-violet");
        expect(result.theme).not.toBeNull();
        expect(result.theme!.label).toBe("My Violet");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("falls back to the default with a visible error for a missing user theme", () => {
      const home = makeHome();
      try {
        const result = resolveThemeRef(home, "user:ghost");
        expect(result.theme).toBe(THEMES[DEFAULT_THEME]);
        expect(result.error).toContain("user:ghost");
        expect(result.error).toContain(".moh/themes");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("an empty theme ref falls back to the default with a visible error", () => {
      const result = resolveThemeRef("/nonexistent", "user:broken-or-missing");
      expect(result.theme).toBe(THEMES[DEFAULT_THEME]);
      expect(result.error).toBeTruthy();
    });
  });
});
