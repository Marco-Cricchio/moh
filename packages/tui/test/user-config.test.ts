import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_USER_CONFIG,
  loadUserConfig,
  saveUserConfig,
  userConfigFile,
  withSetting,
} from "../src/user-config";
import type { ThemeName } from "../src/themes";

describe("user config", () => {
  test("defaults when the file is missing", () => {
    const cfg = loadUserConfig(join(tmpdir(), `nope-${Date.now()}`, "config"));
    expect(cfg).toEqual(DEFAULT_USER_CONFIG);
  });

  test("roundtrips through save/load", () => {
    const file = join(mkdtempSync(join(tmpdir(), "moh-uc-")), "config");
    const cfg = withSetting(
      withSetting(DEFAULT_USER_CONFIG, "mode", "dev"),
      "telemetry",
      true,
    );
    saveUserConfig(cfg, file);
    expect(loadUserConfig(file)).toEqual(cfg);
  });

  test("invalid JSON degrades to defaults, never throws", () => {
    const file = join(mkdtempSync(join(tmpdir(), "moh-uc-")), "config");
    saveUserConfig(DEFAULT_USER_CONFIG, file, (f, d) => {
      require("node:fs").writeFileSync(f, d.toUpperCase()); // corrupt
    });
    expect(loadUserConfig(file)).toEqual(DEFAULT_USER_CONFIG);
  });

  test("unknown fields are dropped, known ones coerced field-by-field", () => {
    const file = join(mkdtempSync(join(tmpdir(), "moh-uc-")), "config");
    saveUserConfig(DEFAULT_USER_CONFIG, file, (f, d) => {
      const json = JSON.parse(d);
      json.mode = "weird";
      json.hacker = true;
      json.theme = "gruvbox";
      require("node:fs").writeFileSync(f, JSON.stringify(json));
    });
    const cfg = loadUserConfig(file);
    expect(cfg.mode).toBe("vibe"); // invalid falls back
    expect(cfg.theme).toBe("gruvbox-material"); // legacy name is migrated
  });

  test("all retired persisted theme names migrate into the curated catalog", () => {
    const expected: Record<string, ThemeName> = {
      gruvbox: "gruvbox-material", nord: "tokyo-night", dracula: "neon-noir",
      solarized: "tokyo-night", c64: "phosphor", amiga: "phosphor",
      win95: "tokyo-night", dos: "phosphor", "mac-platinum": "catppuccin",
    };
    for (const [legacy, current] of Object.entries(expected)) {
      const cfg = loadUserConfig("ignored", () => JSON.stringify({ theme: legacy }));
      expect(cfg.theme).toBe(current);
    }
    expect(loadUserConfig("ignored", () => JSON.stringify({ theme: "unknown" })).theme).toBe(DEFAULT_USER_CONFIG.theme);
  });

  test("homeListMax coerces into 3..10, default 5", () => {
    const file = join(mkdtempSync(join(tmpdir(), "moh-uc-")), "config");
    expect(DEFAULT_USER_CONFIG.homeListMax).toBe(5);
    saveUserConfig(DEFAULT_USER_CONFIG, file, (f, d) => {
      const json = JSON.parse(d);
      json.homeListMax = 99;
      require("node:fs").writeFileSync(f, JSON.stringify(json));
    });
    expect(loadUserConfig(file).homeListMax).toBe(10);
  });

  test("userConfigFile defaults to ~/.moh/config", () => {
    expect(userConfigFile().endsWith(join(".moh", "config"))).toBe(true);
    expect(userConfigFile("/tmp/h").endsWith(join(".moh", "config"))).toBe(true);
  });
});

describe("updateCheck (#273)", () => {
  test("defaults on, opt-out roundtrips", () => {
    expect(DEFAULT_USER_CONFIG.updateCheck).toBe(true);
    const file = join(mkdtempSync(join(tmpdir(), "moh-uc-")), "config");
    saveUserConfig(withSetting(DEFAULT_USER_CONFIG, "updateCheck", false), file);
    expect(loadUserConfig(file).updateCheck).toBe(false);
  });

  test("absent flag stays default (no surprise opt-out)", () => {
    const cfg = loadUserConfig("ignored", () => JSON.stringify({ mode: "dev" }));
    expect(cfg.updateCheck).toBe(true);
  });
});
