/**
 * `moh lanes` (ADR-0060): end-to-end over the CLI surface, in-process
 * (the compact-cli convention — spawnSync startup costs ~1.7s per call
 * and would trip the 5s test timeout on multi-command flows). A REAL
 * temporary git repository backs the flow, so worktree/branch operations
 * run the actual git binary; the lane service's injectable runner is
 * exercised at the unit level in @moh/core. This file pins the CLI
 * plumbing: arg parsing, error mapping, exit codes, output.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { DevelopmentLaneStore } from "@moh/core";

/** Runs the CLI in-process with HOME/cwd pinned and output captured. */
async function run(cwd: string, home: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  process.stdout.write = ((s: string) => (stdout.push(s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => (stderr.push(s), true)) as typeof process.stderr.write;
  process.env.HOME = home;
  process.chdir(cwd);
  try {
    const code = await main(["lanes", ...argv]);
    return { code, out: stdout.join(""), err: stderr.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.env.HOME = origHome;
    process.chdir(origCwd);
  }
}

function newRepo(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), "moh-lanes-cli-repo-"));
  execFileSync("git", ["init", "-b", "develop"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@moh.local"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "moh test"], { cwd, stdio: "ignore" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "root"], { cwd, stdio: "ignore" });
  return { cwd, home: mkdtempSync(join(tmpdir(), "moh-lanes-cli-home-")) };
}

describe("moh lanes (ADR-0060)", () => {
  test("--help prints the usage; unknown subcommand exits 2", async () => {
    const { cwd, home } = newRepo();
    const help = await run(cwd, home, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: moh lanes group");
    const unknown = await run(cwd, home, ["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown command "frobnicate"');
  });

  test("group → start → list → show → integrate → abandon, end to end on a real repo", async () => {
    const { cwd, home } = newRepo();
    const group = await run(cwd, home, ["group", "auth", "--target", "develop"]);
    expect(group.code).toBe(0);
    expect(group.out).toContain("feature group");
    expect(group.out).toContain("auth");

    const started = await run(cwd, home, ["start", "auth", "feature/auth-1"]);
    expect(started.code).toBe(0);
    expect(started.out).toContain("branch    feature/auth-1");
    expect(started.out).toContain("base      develop @ ");
    const laneId = /lane (lane-\S+)/.exec(started.out)?.[1]!;
    expect(laneId).toMatch(/^lane-/);
    // The worktree exists on disk, outside the project checkout.
    expect(started.out).toContain(`.moh-lanes/${cwd.split("/").pop()}/feature-auth-1`);

    const list = await run(cwd, home, ["list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain(laneId);
    expect(list.out).toContain("base fresh");
    expect(list.out).toContain("worktree ok");

    const show = await run(cwd, home, ["show", laneId]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("feature/auth-1");

    const integrate = await run(cwd, home, ["integrate", laneId]);
    expect(integrate.code).toBe(0);
    expect(integrate.out).toContain("landed: feature/auth-1 → develop");

    const again = await run(cwd, home, ["integrate", laneId]);
    expect(again.code).toBe(2);
    expect(again.err).toContain("already landed");

    const abandoned = await run(cwd, home, ["abandon", laneId]);
    expect(abandoned.code).toBe(0);
    expect(abandoned.out).toContain("abandoned:");
  });

  test("start refuses a duplicate branch and names the collision", async () => {
    const { cwd, home } = newRepo();
    await run(cwd, home, ["group", "dup", "--target", "develop"]);
    const first = await run(cwd, home, ["start", "dup", "feature/dup"]);
    expect(first.code).toBe(0);
    const second = await run(cwd, home, ["start", "dup", "feature/dup"]);
    expect(second.code).toBe(2);
    expect(second.err).toContain("branch-exists");
  });

  test("start names the missing feature group didactically", async () => {
    const { cwd, home } = newRepo();
    const result = await run(cwd, home, ["start", "nope", "feature/nope-1"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('no feature group "nope"');
    expect(result.err).toContain("moh lanes group nope");
  });

  test("status transition validates the state name and the worktree", async () => {
    const { cwd, home } = newRepo();
    await run(cwd, home, ["group", "stat", "--target", "develop"]);
    const started = await run(cwd, home, ["start", "stat", "feature/stat-1"]);
    const laneId = /lane (lane-\S+)/.exec(started.out)?.[1]!;
    const bad = await run(cwd, home, ["status", laneId, "banana"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('invalid state "banana"');
    const ok = await run(cwd, home, ["status", laneId, "ready"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("→ ready");
    // The registry (user data) reflects the transition.
    const store = new DevelopmentLaneStore({ cwd, home });
    expect(store.listLanes().find((l) => l.id === laneId)?.status).toBe("ready");
  });

  test("lane state persists as user data outside the repository", async () => {
    const { cwd, home } = newRepo();
    await run(cwd, home, ["group", "persist", "--target", "develop"]);
    await run(cwd, home, ["start", "persist", "feature/persist-1"]);
    const store = new DevelopmentLaneStore({ cwd, home });
    expect(store.file.startsWith(join(home, ".moh", "projects"))).toBe(true);
    expect(store.file.startsWith(cwd)).toBe(false);
  });
});
