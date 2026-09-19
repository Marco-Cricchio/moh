/**
 * `moh jev status` (#784): child-process e2e against an isolated HOME (the
 * sibling convention — mpm/usage do the same), with the `typesafe` block
 * written as a raw string so a malformed section is expressible. No
 * network is ever touched: the command is a pure config read.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TYPESAFE_SETTINGS_HINT } from "@moh/core";

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
