/** Atomic theme write correctness (#1425); not a filesystem latency gate. */
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveUserTheme, themesDir, type UserThemeFile } from "../src/user-themes";

const UMASK = 0o027;
// #1747: a loaded CI run paused 12.4s inside one synchronous case. These
// assertions specify permissions/content/atomicity, not a 5s response SLO.
// Keep a bound and report slow phases rather than hiding pauses in retries.
const FILESYSTEM_BUDGET_MS = 20_000;
type Phase = <T>(name: string, work: () => T) => T;
function withHome(work: (home: string, phase: Phase) => void): void {
  const previousUmask = process.umask(UMASK);
  const started = performance.now();
  const timings: Record<string, number> = {};
  const phase: Phase = (name, run) => {
    const before = performance.now();
    try { return run(); }
    finally { timings[name] = Math.round(performance.now() - before); }
  };
  let home: string | undefined;
  try {
    home = phase("create home", () => mkdtempSync(join(tmpdir(), "moh-themes-atomic-")));
    work(home, phase);
  } finally {
    process.umask(previousUmask);
    try { if (home) phase("cleanup", () => rmSync(home!, { recursive: true, force: true })); }
    finally {
      if (performance.now() - started > 5000) console.warn("atomic theme slow phases (ms):", JSON.stringify(timings));
    }
  }
}
const mode = (path: string): number => statSync(path).mode & 0o777;
const theme: UserThemeFile = {
  version: 1,
  id: "my-violet",
  name: "My Violet",
  extends: "tokyo-night",
  colors: { accent: "#B983FF", fg: "#EDEAF4" },
};

describe("saveUserTheme atomic write", () => {
  it("creates the directory with no explicit mode and the file with the umask default", () => withHome((home, phase) => {
    phase("save", () => saveUserTheme(home, theme));
    const dir = themesDir(home);
    phase("assertions", () => {
      expect(mode(dir)).toBe(0o750);
      expect(mode(join(dir, "my-violet.json"))).toBe(0o640);
      expect(readdirSync(dir)).toEqual(["my-violet.json"]);
      expect(JSON.parse(readFileSync(join(dir, "my-violet.json"), "utf8")).id).toBe("my-violet");
    });
  }), FILESYSTEM_BUDGET_MS);

  it("an existing file is replaced by a fresh umask-default file (the old mode is not kept)", () => withHome((home, phase) => {
    const dir = themesDir(home);
    const file = join(dir, "my-violet.json");
    phase("seed", () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(theme));
      chmodSync(file, 0o600);
    });
    phase("save", () => saveUserTheme(home, { ...theme, name: "Renamed" }));
    phase("assertions", () => {
      expect(mode(file)).toBe(0o640);
      expect(JSON.parse(readFileSync(file, "utf8")).name).toBe("Renamed");
    });
  }), FILESYSTEM_BUDGET_MS);

  it("the temp is `.<id>.json.tmp` in the themes directory: a directory squatting on that name makes the write fail", () => withHome((home, phase) => {
    const dir = themesDir(home);
    phase("seed collision", () => mkdirSync(join(dir, ".my-violet.json.tmp"), { recursive: true }));
    phase("assertions", () => {
      expect(() => saveUserTheme(home, theme)).toThrow();
      expect(existsSync(join(dir, "my-violet.json"))).toBe(false);
    });
  }), FILESYSTEM_BUDGET_MS);
});
