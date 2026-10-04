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
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { DevelopmentLaneService, DevelopmentLaneStore } from "@moh/core";

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
    // The worktree exists on disk, under the project's lane root in the
    // user's moh home (ADR-0060 amendment 4) — never inside or beside the
    // checkout.
    expect(started.out).toContain(join(home, ".moh", "projects"));
    expect(started.out).toContain("/lanes/feature-auth-1");
    expect(existsSync(/isolated worktree: (\S+)\)/.exec(started.out)?.[1] ?? ""));

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

describe("moh lanes cleanup (ADR-0060)", () => {
  test("cleanup dry run reports, --apply removes", async () => {
    const { cwd, home } = newRepo();
    await run(cwd, home, ["group", "clean", "--target", "develop"]);
    const started = await run(cwd, home, ["start", "clean", "feature/clean-1"]);
    const laneId = /lane (lane-\S+)/.exec(started.out)?.[1]!;
    // Age the lane past the cutoff by rewriting the registry (user data).
    const store = new DevelopmentLaneStore({ cwd, home });
    const file = store.file;
    const aged = JSON.parse(await import("node:fs").then((m) => m.readFileSync(file, "utf8")));
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    for (const lane of aged.lanes) lane.updatedAt = old;
    (await import("node:fs")).writeFileSync(file, JSON.stringify(aged, null, 2));
    // Materialize the worktree so cleanup sees a clean one (git worktree
    // add really ran, so it already exists; the .git check passes).

    const dry = await run(cwd, home, ["cleanup"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would remove");
    expect(dry.out).toContain("dry run");

    const applied = await run(cwd, home, ["cleanup", "--apply"]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("removed");
    expect(store.listLanes().find((l) => l.id === laneId)?.status).toBe("abandoned");
  });
});

describe("moh lanes remove (single-lane removal)", () => {
  test("removes an abandoned lane's registry row; refuses an active one without --force", async () => {
    const { cwd, home } = newRepo();
    const store = new DevelopmentLaneStore({ cwd, home });
    const group = store.createFeatureGroup({ name: "rm", targetRef: "develop" });
    const lane = store.createLane({
      featureGroupId: group.id, sessionId: "s-rm", worktreePath: join(cwd, "gone-worktree"),
      branchRef: "feature/rm-1", baseRef: "develop", baseRevision: "abc123", targetRef: "develop", relation: "independent",
    });
    // Active lane with a MISSING worktree: the store row is still refused
    // until it is terminal — the registry row is not a substitute for
    // abandon on live git state.
    const refused = await run(cwd, home, ["remove", lane.id]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("moh lanes remove");
    store.setStatus(lane.id, "abandoned");
    const ok = await run(cwd, home, ["remove", lane.id]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("removed");
    expect(store.listLanes()).toEqual([]);
    const again = await run(cwd, home, ["remove", lane.id]);
    expect(again.code).toBe(2);
    expect(again.err).toContain("unknown lane");
  });

  test("--force drops the registry row of a live lane, git untouched", async () => {
    const { cwd, home } = newRepo();
    const store = new DevelopmentLaneStore({ cwd, home });
    const group = store.createFeatureGroup({ name: "rmf", targetRef: "develop" });
    const lane = store.createLane({
      featureGroupId: group.id, sessionId: "s-rmf", worktreePath: join(cwd, "live-worktree"),
      branchRef: "feature/rm-2", baseRef: "develop", baseRevision: "abc123", targetRef: "develop", relation: "independent",
    });
    execFileSync("mkdir", ["-p", join(cwd, "live-worktree", ".git")]);
    const forced = await run(cwd, home, ["remove", lane.id, "--force"]);
    expect(forced.code).toBe(0);
    expect(store.listLanes()).toEqual([]);
  });
});

describe("moh lanes delete (worktree + branch + registry row)", () => {
  test("deletes a lane outright: the worktree directory is removed from disk", async () => {
    const { cwd, home } = newRepo();
    const store = new DevelopmentLaneStore({ cwd, home });
    const service = new DevelopmentLaneService({ cwd, home });
    const group = await service.ensureFeatureGroup("del", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s-del", branchRef: "feature/del-3", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const lane = store.listLanes()[0]!;
    expect(existsSync(lane.worktreePath)).toBe(true);
    const result = await run(cwd, home, ["delete", lane.id]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("deleted");
    expect(store.listLanes()).toEqual([]);
    expect(existsSync(lane.worktreePath)).toBe(false); // the directory is gone
  });

  test("--keep-worktree drops only the registry row, directory stays", async () => {
    const { cwd, home } = newRepo();
    const store = new DevelopmentLaneStore({ cwd, home });
    const service = new DevelopmentLaneService({ cwd, home });
    const group = await service.ensureFeatureGroup("del", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s-del", branchRef: "feature/del-4", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const lane = store.listLanes()[0]!;
    const result = await run(cwd, home, ["delete", lane.id, "--keep-worktree"]);
    expect(result.code).toBe(0);
    expect(store.listLanes()).toEqual([]);
    expect(existsSync(lane.worktreePath)).toBe(true); // untouched on disk
  });
});
