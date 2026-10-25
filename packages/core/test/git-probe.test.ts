/**
 * #1679: the git probe is off by default and, when `MOH_GIT_PROBE=<file>` is
 * set, records one line per `gitSync` call without changing its result.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSync } from "../src/git";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.MOH_GIT_PROBE;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "moh-git-probe-"));
  dirs.push(d);
  return d;
};

describe("MOH_GIT_PROBE (#1679)", () => {
  test("off by default: no file, and the result is the plain one", () => {
    const dir = tmp();
    const plain = gitSync(dir, ["--version"], { dir: "-C", stderr: "pipe" });
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toStartWith("git version");
    expect(readdirEmpty(dir)).toBe(true);
  });

  test("on: one JSON line per call with duration, pid and exit code; same result", () => {
    const dir = tmp();
    const file = join(dir, "probe.jsonl");
    const plain = gitSync(dir, ["--version"], { dir: "-C", stderr: "pipe" });
    process.env.MOH_GIT_PROBE = file;
    const probed = gitSync(dir, ["--version"], { dir: "-C", stderr: "pipe" });
    gitSync(dir, ["rev-parse", "--git-dir"], { dir: "-C", stderr: "ignore" }); // not a repo: nonzero exit
    expect(probed).toEqual(plain);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ cwd: dir, args: ["--version"], exitCode: 0, signal: null, threw: null });
    expect(typeof lines[0].ms).toBe("number");
    expect(typeof lines[0].pid).toBe("number");
    expect(lines[1].exitCode).not.toBe(0);
    expect(lines[0].stack).toBeUndefined(); // only slow calls carry the caller's frames
  });

  test("an unwritable probe file never changes the call", () => {
    const dir = tmp();
    process.env.MOH_GIT_PROBE = join(dir, "no-such-dir", "probe.jsonl");
    expect(gitSync(dir, ["--version"], { dir: "-C", stderr: "pipe" }).exitCode).toBe(0);
    expect(existsSync(process.env.MOH_GIT_PROBE)).toBe(false);
  });
});

function readdirEmpty(dir: string): boolean {
  return !existsSync(join(dir, "probe.jsonl"));
}
