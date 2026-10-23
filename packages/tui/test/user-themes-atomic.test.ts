/**
 * Characterization of the atomic write in `saveUserTheme` (#1425): temp name
 * `.<id>.json.tmp` (leading dot, inside the themes directory), no explicit
 * file mode (umask decides), directory created without an explicit mode.
 * Written against the code before the shared helper; it passes unchanged after.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveUserTheme, themesDir, type UserThemeFile } from "../src/user-themes";

const UMASK = 0o027;
let previousUmask = 0;
beforeAll(() => {
  previousUmask = process.umask(UMASK);
});
afterAll(() => {
  process.umask(previousUmask);
});

const mode = (path: string): number => statSync(path).mode & 0o777;

const theme: UserThemeFile = {
  version: 1,
  id: "my-violet",
  name: "My Violet",
  extends: "tokyo-night",
  colors: { accent: "#B983FF", fg: "#EDEAF4" },
};

describe("saveUserTheme atomic write", () => {
  it("creates the directory with no explicit mode and the file with the umask default", () => {
    const home = mkdtempSync(join(tmpdir(), "moh-themes-atomic-"));
    saveUserTheme(home, theme);
    const dir = themesDir(home);
    expect(mode(dir)).toBe(0o750); // 0o777 & ~umask
    expect(mode(join(dir, "my-violet.json"))).toBe(0o640); // 0o666 & ~umask
    expect(readdirSync(dir)).toEqual(["my-violet.json"]);
    expect(JSON.parse(readFileSync(join(dir, "my-violet.json"), "utf8")).id).toBe("my-violet");
  });

  it("an existing file is replaced by a fresh umask-default file (the old mode is not kept)", () => {
    const home = mkdtempSync(join(tmpdir(), "moh-themes-atomic-"));
    const dir = themesDir(home);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "my-violet.json");
    writeFileSync(file, JSON.stringify(theme));
    chmodSync(file, 0o600);
    saveUserTheme(home, { ...theme, name: "Renamed" });
    expect(mode(file)).toBe(0o640);
    expect(JSON.parse(readFileSync(file, "utf8")).name).toBe("Renamed");
  });

  it("the temp is `.<id>.json.tmp` in the themes directory: a directory squatting on that name makes the write fail", () => {
    const home = mkdtempSync(join(tmpdir(), "moh-themes-atomic-"));
    const dir = themesDir(home);
    mkdirSync(join(dir, ".my-violet.json.tmp"), { recursive: true });
    expect(() => saveUserTheme(home, theme)).toThrow();
    expect(existsSync(join(dir, "my-violet.json"))).toBe(false);
  });
});
