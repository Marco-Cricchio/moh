/**
 * `moh jev status` (#784): child-process e2e against an isolated HOME (the
 * sibling convention — mpm/usage do the same), with the `typesafe` block
 * written as a raw string so a malformed section is expressible. No
 * network is ever touched: the command is a pure config read.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TYPESAFE_SETTINGS_HINT } from "@moh/jev-guard";
import { JEV_SESSION_ONLY_NAMES, JEV_USAGE, JEV_USE_CASE_NAMES } from "../src/jev";

const TMP_ROOT = join(tmpdir(), "moh-jev-cli");
const KEY = "ts_live_0000secret9f2a";

/** `config` is written verbatim to `~/.moh/config`; `undefined` leaves the
 * file absent (the zero-config case). */
function harness(config?: string) {
  mkdirSync(TMP_ROOT, { recursive: true });
  const home = mkdtempSync(join(TMP_ROOT, "home-"));
  const cwd = mkdtempSync(join(TMP_ROOT, "proj-"));
  writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
  if (config !== undefined) {
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(home, ".moh", "config"), config);
  }
  const spawn = (argv: string[]) => {
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...argv],
      { cwd, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    return {
      code: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  };
  return { home, cwd, spawn };
}

const ACTIVE_CONFIG = JSON.stringify({ typesafe: { apiKey: KEY } });

describe("moh jev status (#784)", () => {
  test("--help prints the usage", () => {
    const { spawn } = harness();
    const { code, stdout } = spawn(["jev", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: moh jev status");
  });

  test("active: masked key and effective timeout, exit 0", () => {
    const { spawn } = harness(ACTIVE_CONFIG);
    const { code, stdout, stderr } = spawn(["jev", "status"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("  jev             active (key …9f2a, timeout 2500ms)\n  routing         off\n  injection       off\n  quality gate    off\n  classification  on\n  rerank          off\n  skills          off\n");
    // The key only ever reaches the screen masked.
    expect(stdout).not.toContain(KEY);
  });

  test("inactive: no config file at all → hint on how to activate, exit 0", () => {
    const { spawn } = harness();
    const { code, stdout } = spawn(["jev", "status"]);
    expect(code).toBe(0);
    expect(stdout).toBe(`  jev             inactive\n  routing         off\n  injection       off\n  quality gate    off\n  classification  on\n  rerank          off\n  skills          off\n  hint            ${TYPESAFE_SETTINGS_HINT}\n`);
  });

  test("inactive: a key-less typesafe block reads the same as an absent one", () => {
    const { spawn } = harness(JSON.stringify({ typesafe: {} }));
    const { code, stdout } = spawn(["jev", "status"]);
    expect(code).toBe(0);
    expect(stdout).toContain("  jev             inactive");
    expect(stdout).toContain(TYPESAFE_SETTINGS_HINT);
  });

  test("active with a routing opt-in and a custom timeout", () => {
    const { spawn } = harness(JSON.stringify({ typesafe: { apiKey: KEY, timeoutMs: 5000, routing: true } }));
    const { code, stdout } = spawn(["jev", "status"]);
    expect(code).toBe(0);
    expect(stdout).toBe("  jev             active (key …9f2a, timeout 5000ms)\n  routing         on\n  injection       off\n  quality gate    off\n  classification  on\n  rerank          off\n  skills          off\n");
  });

  test("--json active: exactly the pinned object, one line", () => {
    const { spawn } = harness(ACTIVE_CONFIG);
    const { code, stdout } = spawn(["jev", "status", "--json"]);
    expect(code).toBe(0);
    expect(stdout).toBe('{"active":true,"keyHint":"…9f2a","timeoutMs":2500,"routing":false,"injection":false,"lint":false,"classification":true,"rerank":false,"skills":false}\n');
  });

  test("--json inactive: keyHint absent (never nulled), other keys present", () => {
    const { spawn } = harness();
    const { code, stdout } = spawn(["jev", "status", "--json"]);
    expect(code).toBe(0);
    expect(stdout).toBe('{"active":false,"timeoutMs":2500,"routing":false,"injection":false,"lint":false,"classification":true,"rerank":false,"skills":false}\n');
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect("keyHint" in parsed).toBe(false);
  });

  test("--json is informational: exit 0 in both states", () => {
    const active = harness(ACTIVE_CONFIG);
    const inactive = harness();
    expect(active.spawn(["jev", "status", "--json"]).code).toBe(0);
    expect(inactive.spawn(["jev", "status", "--json"]).code).toBe(0);
  });

  test("unknown arguments: usage error, exit 2", () => {
    const { spawn } = harness(ACTIVE_CONFIG);
    for (const argv of [
      ["jev"],
      ["jev", "foo"],
      ["jev", "status", "extra"],
      ["jev", "status", "--nope"],
    ]) {
      const { code, stdout, stderr } = spawn(argv);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("usage: moh jev status");
      // A usage error never reports state: no half answer before the error.
      expect(stderr).not.toContain("  jev          inactive");
    }
  });

  test("malformed typesafe section: loud error on stderr, exit 2", () => {
    const { spawn } = harness(JSON.stringify({ typesafe: { timeoutMs: "fast" } }));
    const { code, stdout, stderr } = spawn(["jev", "status"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("typesafe section");
    expect(stderr).toContain("timeoutMs");
  });

  test("a corrupt config file is tolerated by the guardian: inactive, exit 0", () => {
    const { spawn } = harness("{ not json");
    const { code, stdout } = spawn(["jev", "status"]);
    expect(code).toBe(0);
    expect(stdout).toContain("  jev             inactive");
  });
});

// The temp tree is per-test-mkdtemp under one root; a single sweep at the
// end keeps the suite from littering while staying robust on failure.
process.on("exit", () => rmSync(TMP_ROOT, { recursive: true, force: true }));

/**
 * #833: `moh jev <use-case> on|off` — the shell twin of the Settings
 * entries. What these pin: the write lands in `~/.moh/config`, nothing else
 * in the file is touched, the names that exist are the names it accepts, and
 * the guardrail's absence is said out loud instead of looking like a typo.
 */
describe("moh jev <use-case> on|off (#833)", () => {
  const readConfig = (home: string): Record<string, unknown> => {
    const file = join(home, ".moh", "config");
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  };

  test("each persistable use case writes its flag, and only its flag", () => {
    for (const [name, key] of [
      ["routing", "routing"],
      ["injection", "injection"],
      ["classification", "classification"],
      ["lint", "lint"],
      ["rerank", "rerank"],
      ["skills", "skills"],
    ] as const) {
      const { home, spawn } = harness(ACTIVE_CONFIG);
      const { code, stdout, stderr } = spawn(["jev", name, "on"]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("from your next session");
      const config = readConfig(home);
      expect((config.typesafe as Record<string, unknown>)[key]).toBe(true);
      // The key is never touched by a flag write.
      expect((config.typesafe as Record<string, unknown>).apiKey).toBe(KEY);
    }
  });

  test("off writes false; the status report follows on the next read", () => {
    const { home, spawn } = harness(ACTIVE_CONFIG);
    expect(spawn(["jev", "classification", "off"]).code).toBe(0);
    expect((readConfig(home).typesafe as Record<string, unknown>).classification).toBe(false);
    const status = spawn(["jev", "status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("classification  off");
    // ...and back on, without touching anything else.
    expect(spawn(["jev", "classification", "on"]).code).toBe(0);
    expect(spawn(["jev", "status"]).stdout).toContain("classification  on");
  });

  test("an unrelated section of the config survives the write", () => {
    const { home, spawn } = harness(JSON.stringify({ typesafe: { apiKey: KEY }, telemetry: true, theme: "nord" }));
    expect(spawn(["jev", "skills", "on"]).code).toBe(0);
    const config = readConfig(home);
    expect(config.telemetry).toBe(true);
    expect(config.theme).toBe("nord");
    expect((config.typesafe as Record<string, unknown>).skills).toBe(true);
  });

  test("with no config file at all the flag write creates just that section", () => {
    const { home, spawn } = harness();
    expect(spawn(["jev", "routing", "on"]).code).toBe(0);
    expect(readConfig(home)).toEqual({ typesafe: { routing: true } });
  });

  test("the guardrail is refused as session-only, not as a typo", () => {
    const { spawn } = harness(ACTIVE_CONFIG);
    const { code, stdout, stderr } = spawn(["jev", "guardrail", "off"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("the guardrail has no persistent switch");
    expect(stderr).toContain("/jev");
    expect(stderr).not.toContain("unknown use case");
  });

  test("an unknown name lists nothing invented; a missing action is a usage error", () => {
    const { spawn } = harness(ACTIVE_CONFIG);
    for (const argv of [["jev", "bananas", "on"], ["jev", "routing"], ["jev", "routing", "maybe"], ["jev", "routing", "on", "extra"]]) {
      const { code, stdout, stderr } = spawn(argv);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("usage: moh jev status");
    }
    expect(spawn(["jev", "bananas", "on"]).stderr).toContain('unknown use case "bananas"');
    expect(spawn(["jev", "routing"]).stderr).toContain('an action is required — "on" or "off"');
  });

  test("--json belongs to status: a set form refuses it", () => {
    const { spawn } = harness(ACTIVE_CONFIG);
    const { code, stderr } = spawn(["jev", "routing", "on", "--json"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--json belongs to status");
  });

  test("a malformed section fails loudly on write, exit 2, file untouched", () => {
    const broken = JSON.stringify({ typesafe: { timeoutMs: "fast" } });
    const { home, spawn } = harness(broken);
    const { code, stdout, stderr } = spawn(["jev", "lint", "on"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("typesafe section");
    // The broken bytes are exactly what the user wrote: a failed write must
    // not rewrite the file into something "valid but different".
    expect(readFileSync(join(home, ".moh", "config"), "utf8")).toBe(broken);
  });

  test("--help documents the set form and the six names", () => {
    const { spawn } = harness();
    const { code, stdout } = spawn(["jev", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("moh jev <use-case> on|off");
    for (const name of ["routing", "injection", "classification", "lint", "rerank", "skills"]) {
      expect(stdout).toContain(name);
    }
    expect(stdout).toContain("guardrail");
  });
});

/**
 * #833: the usage text is extracted verbatim by the manual generator, so it
 * cannot interpolate the name table — this pins the two together instead.
 */
describe("the usage text and the name table agree (#833)", () => {
  test("every persistable name is listed, and the guardrail is named as session-only", () => {
    for (const name of JEV_USE_CASE_NAMES) expect(JEV_USAGE).toContain(name);
    for (const name of JEV_SESSION_ONLY_NAMES) expect(JEV_USAGE).toContain(name);
    expect(JEV_USAGE).toContain("Session-only");
    // Nothing in the usage claims guardrail is writable.
    expect(JEV_USAGE).not.toContain("Use cases: routing, injection, classification, lint, rerank, skills,");
  });

  test("the manual's generated page carries the same text", () => {
    const page = readFileSync(join(import.meta.dir, "..", "..", "core", "src", "manual", "cli-reference.md"), "utf8");
    expect(page).toContain("moh jev <use-case> on|off");
    expect(page).toContain("Session-only (no flag to write): guardrail");
  });
});
