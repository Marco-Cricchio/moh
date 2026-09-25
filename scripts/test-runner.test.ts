import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "moh-runner-test-"));
  try {
    for (const dir of ["scripts", "bin", "packages/tui/test/pty"]) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ["test.sh", "test-pty-parallel.sh"]) cpSync(resolve("scripts", file), join(root, "scripts", file));
    writeFileSync(join(root, "packages/tui/test/component.test.ts"), "");
    for (const file of ["a.test.ts", "b.test.ts"]) writeFileSync(join(root, "packages/tui/test/pty", file), "");
    const bun = join(root, "bin/bun");
    writeFileSync(bun, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$TRACE"\nif [[ "$*" == *a.test.ts* ]] && [ "\${CRASH:-0}" = 1 ]; then\n  echo 'simulated process crash'\n  exit 7\nfi\necho '(pass) fixture'\n`);
    chmodSync(bun, 0o755);
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function invoke(root: string, script: string, args: string[] = [], extra: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", `scripts/${script}`, ...args], {
    cwd: root,
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TRACE: join(root, "trace"), MOH_TEST_LOG: join(root, "main.log"), MOH_PTY_LOG_DIR: join(root, "pty-logs"), MOH_PTY_JOBS: "2", MOH_PTY_PARALLEL: "1", ...extra },
  });
}

describe("local test runners", () => {
  test("PTY process failure without a Bun failure marker remains red and keeps its log, without retry", () => fixture(root => {
    const result = invoke(root, "test-pty-parallel.sh", [], { CRASH: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(root, "pty-logs/a.test.ts.log"), "utf8")).toContain("simulated process crash");
    expect(readFileSync(join(root, "pty-logs/results.tsv"), "utf8")).toContain("7\tpackages/tui/test/pty/a.test.ts");
    expect(readFileSync(join(root, "trace"), "utf8").trim().split("\n")).toHaveLength(2);
  }));

  test("TUI directory runs components before separate PTY files", () => fixture(root => {
    const result = invoke(root, "test.sh", ["packages/tui/test"]);
    expect(result.exitCode).toBe(0);
    const calls = readFileSync(join(root, "trace"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe("test packages/tui/test/component.test.ts");
    expect(calls.slice(1).every(call => call.includes("/pty/"))).toBe(true);
  }));

  test("a focused test bypasses the directory split", () => fixture(root => {
    expect(invoke(root, "test.sh", ["packages/tui/test/component.test.ts"]).exitCode).toBe(0);
    expect(readFileSync(join(root, "trace"), "utf8").trim()).toBe("test packages/tui/test/component.test.ts");
  }));

  test("TUI wrapper propagates PTY failure and records its log path", () => fixture(root => {
    expect(invoke(root, "test.sh", ["packages/tui/test"], { CRASH: "1" }).exitCode).not.toBe(0);
    expect(readFileSync(join(root, "main.log"), "utf8")).toContain(join(root, "pty-logs"));
  }));

  test("unwritable log destinations fail visibly", () => fixture(root => {
    expect(invoke(root, "test.sh", ["packages/tui/test/component.test.ts"], { MOH_TEST_LOG: root }).exitCode).not.toBe(0);
    mkdirSync(join(root, "pty-logs/results.tsv"), { recursive: true });
    expect(invoke(root, "test-pty-parallel.sh").exitCode).not.toBe(0);
  }));

  test("invalid PTY concurrency is rejected", () => fixture(root => {
    expect(invoke(root, "test-pty-parallel.sh", [], { MOH_PTY_JOBS: "oops" }).exitCode).not.toBe(0);
  }));
});
