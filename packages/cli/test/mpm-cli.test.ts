/**
 * `moh mpm` (#618): child-process e2e only (never in-process runCommand-style
 * calls — see session memory) against an isolated HOME and a small mapped
 * workspace: ready report, disabled-by-user report naming the reason, JSON
 * mode, and redaction (no source content in output).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpmService, projectMapDir } from "@moh/core";
import { extractWorkspace } from "../../core/src/mpm/extractor";

const TMP_ROOT = join(tmpdir(), "moh-mpm-cli");

function harness(userConfig?: object) {
  mkdirSync(TMP_ROOT, { recursive: true });
  const home = mkdtempSync(join(TMP_ROOT, "home-"));
  const cwd = mkdtempSync(join(TMP_ROOT, "proj-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  const source = 'import { b } from "./b";\nexport const markerConstA = 1;\n';
  writeFileSync(join(cwd, "src/a.ts"), source);
  writeFileSync(join(cwd, "src/b.ts"), "export const b = 2;\n");
  writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
  const service = new MpmService(projectMapDir(join(home, ".moh"), cwd));
  service.rebuild(extractWorkspace(cwd));
  if (userConfig) {
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(home, ".moh", "config"), JSON.stringify(userConfig));
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
  return { home, cwd, spawn, source };
}

describe("moh mpm (#618)", () => {
  test("--help prints the usage", () => {
    const { spawn } = harness();
    const { code, stdout } = spawn(["mpm", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: moh mpm");
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  test("ready projection: status, coverage, budgets — no source content", () => {
    const { spawn, source } = harness();
    const { code, stdout } = spawn(["mpm"]);
    expect(code).toBe(0);
    expect(stdout).toContain("MPM ✓ ready");
    expect(stdout).toContain("typescript");
    expect(stdout).toContain("budget:");
    // Redaction: the file's content never appears, only counts and paths.
    expect(stdout).not.toContain("markerConstA");
    expect(stdout).not.toContain(source);
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  test("user disablement: 'MPM — disabled (user config)'", () => {
    const { spawn } = harness({ mpm: { enabled: false } });
    const { code, stdout } = spawn(["mpm"]);
    expect(code).toBe(0);
    expect(stdout).toContain("disabled (user config)");
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  test("project disablement: reason names the project side", () => {
    const { home, cwd, spawn } = harness();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", mpm: { enabled: false } }));
    const { code, stdout } = spawn(["mpm"]);
    expect(code).toBe(0);
    expect(stdout).toContain("disabled (project config)");
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("--json emits the full diagnostics object", () => {
    const { spawn } = harness({ mpm: { quota: { maxFiles: 500 } } });
    const { code, stdout } = spawn(["mpm", "--json"]);
    expect(code).toBe(0);
    const diag = JSON.parse(stdout);
    expect(diag.status).toBe("ready");
    expect(diag.budget.maxFiles).toBe(500);
    expect(diag.fileCount).toBeGreaterThan(0);
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });
});
