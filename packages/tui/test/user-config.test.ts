import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
});

// Real temporary file twins of the `read` / `write` tests above (#1431).
// The mode checks look at the final file only, never at the temp file.
describe("user config — real file twins (#1431)", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "moh-uc-")), "config");

  test("invalid JSON degrades to defaults, never throws (real file)", () => {
    const file = tmp();
    saveUserConfig(DEFAULT_USER_CONFIG, file);
    writeFileSync(file, readFileSync(file, "utf8").toUpperCase()); // corrupt
    expect(loadUserConfig(file)).toEqual(DEFAULT_USER_CONFIG);
  });

  test("unknown fields are dropped, known ones coerced field-by-field (real file)", () => {
    const file = tmp();
    saveUserConfig(DEFAULT_USER_CONFIG, file);
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.mode = "weird";
    json.hacker = true;
    json.theme = "gruvbox";
    writeFileSync(file, JSON.stringify(json));
    const cfg = loadUserConfig(file);
    expect(cfg.mode).toBe("vibe"); // invalid falls back
    expect(cfg.theme).toBe("gruvbox-material"); // legacy name is migrated
  });

  test("all retired persisted theme names migrate into the curated catalog (real file)", () => {
    const expected: Record<string, ThemeName> = {
      gruvbox: "gruvbox-material", nord: "tokyo-night", dracula: "neon-noir",
      solarized: "tokyo-night", c64: "phosphor", amiga: "phosphor",
      win95: "tokyo-night", dos: "phosphor", "mac-platinum": "catppuccin",
    };
    const file = tmp();
    for (const [legacy, current] of Object.entries(expected)) {
      writeFileSync(file, JSON.stringify({ theme: legacy }));
      expect(loadUserConfig(file).theme).toBe(current);
    }
    writeFileSync(file, JSON.stringify({ theme: "unknown" }));
    expect(loadUserConfig(file).theme).toBe(DEFAULT_USER_CONFIG.theme);
  });

  test("homeListMax coerces into 3..10 (real file)", () => {
    const file = tmp();
    saveUserConfig(DEFAULT_USER_CONFIG, file);
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.homeListMax = 99;
    writeFileSync(file, JSON.stringify(json));
    expect(loadUserConfig(file).homeListMax).toBe(10);
  });

  test("absent flag stays default (no surprise opt-out) (real file)", () => {
    const file = tmp();
    writeFileSync(file, JSON.stringify({ mode: "dev" }));
    expect(loadUserConfig(file).updateCheck).toBe(true);
  });

  test("a malformed or non-object file saves as a whole new file; unknown sections survive a save (real file)", () => {
    const file = tmp();
    writeFileSync(file, "garbage");
    saveUserConfig(DEFAULT_USER_CONFIG, file);
    expect(loadUserConfig(file)).toEqual(DEFAULT_USER_CONFIG);

    const seed = { futureSection: { x: [1] }, mcpServers: { s: { type: "stdio", command: "bun" } }, auth: { tokens: {} } };
    writeFileSync(file, JSON.stringify(seed));
    saveUserConfig(withSetting(DEFAULT_USER_CONFIG, "mode", "dev"), file);
    const data = JSON.parse(readFileSync(file, "utf8"));
    expect(data.futureSection).toEqual(seed.futureSection);
    expect(data.mcpServers).toEqual(seed.mcpServers);
    expect(data.auth).toEqual(seed.auth);
    expect(data.mode).toBe("dev");
  });

  test("final mode is 0600, even over a pre-existing 0644 file (real file)", () => {
    const file = tmp();
    writeFileSync(file, "{}");
    chmodSync(file, 0o644);
    saveUserConfig(DEFAULT_USER_CONFIG, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
