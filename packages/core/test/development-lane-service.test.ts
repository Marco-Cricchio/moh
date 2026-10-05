import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentLaneService, mainCheckoutFor, resolveWorktreePath, type LaneGitRunner, type LaneGitResult } from "../src/index";

function project(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), "moh-lane-svc-"));
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return { cwd, home: mkdtempSync(join(tmpdir(), "moh-lane-svc-home-")) };
}

/** Records argv and answers per prefix. */
function fakeGit(respond: (args: string[]) => LaneGitResult | undefined): { runner: LaneGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: LaneGitRunner = async (args) => {
    calls.push(args);
    return respond(args) ?? { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("development lane service", () => {
  test("refuses a non-repository before any git call", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-lane-norepo-"));
    const { runner, calls } = fakeGit(() => ({ code: 0, stdout: "", stderr: "" }));
    const service = new DevelopmentLaneService({ cwd, home: mkdtempSync(join(tmpdir(), "h-")), git: runner });
    const group = await service.ensureFeatureGroup("alpha", "develop");
    const result = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/alpha-1", baseRef: "develop",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not-a-repo");
    expect(calls).toEqual([]);
  });

  test("creates a worktree lane with the exact base revision recorded", async () => {
    const { cwd, home } = project();
    const { runner, calls } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b4se000\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("alpha", "develop");
    const result = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/alpha-1", baseRef: "develop",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseRevision).toBe("b4se000");
      expect(result.value.relation).toBe("independent");
      expect(result.value.worktreePath).toBe(resolveWorktreePath(cwd, "feature/alpha-1", home));
    }
    const add = calls.find((args) => args[0] === "worktree");
    expect(add).toBeDefined();
    expect(add).toEqual(["worktree", "add", "-b", "feature/alpha-1", resolveWorktreePath(cwd, "feature/alpha-1", home), "b4se000"]);
  });

  test("fails before git write when the registry would refuse the pair", async () => {
    const { cwd, home } = project();
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "r1\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("beta", "develop");
    const first = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/beta-1", baseRef: "develop",
    });
    expect(first.ok).toBe(true);
    const second = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/beta-2", baseRef: "develop",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe("registry");
  });

  test("reports an unknown base ref without writing state", async () => {
    const { cwd, home } = project();
    const { runner } = fakeGit(() => ({ code: 1, stdout: "", stderr: "fatal: bad revision" }));
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("gamma", "develop");
    const result = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/gamma-1", baseRef: "nope",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unknown-ref");
    expect(service.listLanes(group.id)).toEqual([]);
  });

  test("an existing branch fails before the worktree is created", async () => {
    const { cwd, home } = project();
    const { runner, calls } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[2] === "refs/heads/feature/delta-1") {
        return { code: 0, stdout: "x\n", stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: "b\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("delta", "develop");
    const result = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/delta-1", baseRef: "develop",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("branch-exists");
    expect(calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  test("freshness detects a moved base ref without rewriting the lane", async () => {
    const { cwd, home } = project();
    let develop = "b4se000";
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[2]?.startsWith("develop")) {
        return { code: 0, stdout: `${develop}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("epsilon", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/epsilon-1", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const laneId = created.ok ? created.value.id : "";
    const before = await service.freshness(laneId);
    expect(before.ok && before.value.stale).toBe(false);
    develop = "m0ved99";
    const after = await service.freshness(laneId);
    expect(after.ok && after.value.stale).toBe(true);
    expect(after.ok && after.value.currentRevision).toBe("m0ved99");
    const lane = service.listLanes(group.id)[0]!;
    expect(lane.baseRevision).toBe("b4se000");
  });

  test("abandon removes the worktree and branch, then marks the lane abandoned", async () => {
    const { cwd, home } = project();
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("zeta", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/zeta-1", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const laneId = created.ok ? created.value.id : "";
    const result = await service.abandon(laneId);
    expect(result.ok && result.value.status).toBe("abandoned");
    const statuses = await service.setStatus(laneId, "active");
    expect(statuses.ok).toBe(false);
  });

  test("rejects a status change when the lane worktree is missing", async () => {
    const { cwd, home } = project();
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("eta", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/eta-1", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const lane = created.ok ? created.value : null;
    expect(lane && !existsSync(join(lane.worktreePath, ".git"))).toBe(true);
    const result = await service.setStatus(lane!.id, "ready");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("worktree-exists");
  });

  test("integrate lands cleanly and marks the lane landed", async () => {
    const { cwd, home } = project();
    const branches = new Set<string>();
    const { runner, calls } = fakeGit((args) => {
      if (args[0] === "worktree") { branches.add(args[3]!); return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) {
        return branches.has(args[2]!.slice("refs/heads/".length)) ? { code: 0, stdout: "h\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: "t0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("theta", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/theta-1", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const result = await service.integrate(created.ok ? created.value.id : "");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe("landed");
    const merge = calls.find((args) => args[0] === "merge");
    expect(merge).toEqual(["merge", "--no-ff", "--no-edit", "feature/theta-1"]);
    expect(calls.some((args) => args[0] === "merge" && args[1] === "--abort")).toBe(false);
  });

  test("integrate on conflict aborts the target merge and stores resumable conflict state", async () => {
    const { cwd, home } = project();
    const branches = new Set<string>();
    let mergeAttempts = 0;
    const { runner, calls } = fakeGit((args) => {
      if (args[0] === "worktree") { branches.add(args[3]!); return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) {
        return branches.has(args[2]!.slice("refs/heads/".length)) ? { code: 0, stdout: "lane999\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: "targ222\n", stderr: "" };
      if (args[0] === "merge" && args[1] !== "--abort") {
        mergeAttempts += 1;
        // First integrate conflicts; the post-resolve retry succeeds.
        return mergeAttempts === 1 ? { code: 1, stdout: "", stderr: "CONFLICT (content): Merge conflict in file.txt" } : { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("iota", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/iota-1", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const result = await service.integrate(created.ok ? created.value.id : "");
    expect(result.ok).toBe(true);
    if (result.ok && result.value.outcome === "conflicted") {
      expect(result.value.conflict.targetRevision).toBe("targ222");
      expect(result.value.conflict.laneRevision).toBe("lane999");
    } else if (result.ok) {
      throw new Error("expected a conflicted outcome");
    }
    // The merge was aborted in the target; the lane stays inspectable.
    expect(calls.some((args) => args[0] === "merge" && args[1] === "--abort")).toBe(true);
    const lane = service.listLanes(group.id)[0]!;
    expect(lane.status).toBe("conflicted");
    // Only a conflicted lane may resolve; a fresh retry that succeeds lands it.
    const retry = await service.resolve(lane.id);
    expect(retry.ok && retry.value.status).toBe("landed");
  });

  test("integrate merges the worktree's live branch and syncs the registry", async () => {
    const { cwd, home } = project();
    const branches = new Set<string>(["fix/semantic"]);
    const { runner, calls } = fakeGit((args) => {
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: "fix/semantic\n", stderr: "" };
      if (args[0] === "worktree") {
        branches.add(args[3]!);
        const path = args[4]!;
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, ".git"), "gitdir: fake\n");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) {
        return branches.has(args[2]!.slice("refs/heads/".length)) ? { code: 0, stdout: "h\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: "t0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("mu", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "moh/auto-s1", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const result = await service.integrate(created.ok ? created.value.id : "");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe("landed");
    const merge = calls.find((args) => args[0] === "merge");
    expect(merge).toEqual(["merge", "--no-ff", "--no-edit", "fix/semantic"]);
    const lane = service.listLanes(group.id)[0]!;
    expect(lane.branchRef).toBe("fix/semantic");
    expect(lane.status).toBe("landed");
  });

  test("resolve merges the worktree's live branch after a semantic rename", async () => {
    const { cwd, home } = project();
    const branches = new Set<string>(["fix/renamed"]);
    let mergeAttempts = 0;
    const { runner, calls } = fakeGit((args) => {
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: "fix/renamed\n", stderr: "" };
      if (args[0] === "worktree") {
        branches.add(args[3]!);
        const path = args[4]!;
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, ".git"), "gitdir: fake\n");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) {
        return branches.has(args[2]!.slice("refs/heads/".length)) ? { code: 0, stdout: "lane777\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: "targ111\n", stderr: "" };
      if (args[0] === "merge" && args[1] !== "--abort") {
        mergeAttempts += 1;
        return mergeAttempts === 1 ? { code: 1, stdout: "", stderr: "CONFLICT (content): Merge conflict in file.txt" } : { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("nu", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "moh/auto-s1", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const conflicted = await service.integrate(created.ok ? created.value.id : "");
    expect(conflicted.ok && conflicted.value.outcome === "conflicted").toBe(true);
    const retry = await service.resolve(created.ok ? created.value.id : "");
    expect(retry.ok && retry.value.status).toBe("landed");
    const merges = calls.filter((args) => args[0] === "merge" && args[1] !== "--abort");
    expect(merges.every((args) => args[3] === "fix/renamed")).toBe(true);
    expect(service.listLanes(group.id)[0]!.branchRef).toBe("fix/renamed");
  });

  test("integrate falls back to the registry branchRef when the live branch is unknown", async () => {
    const { cwd, home } = project();
    const branches = new Set<string>();
    const { runner, calls } = fakeGit((args) => {
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: "ghost/branch\n", stderr: "" };
      if (args[0] === "worktree") {
        branches.add(args[3]!);
        const path = args[4]!;
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, ".git"), "gitdir: fake\n");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) {
        return branches.has(args[2]!.slice("refs/heads/".length)) ? { code: 0, stdout: "h\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: "t0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("xi", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "moh/auto-s1", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const result = await service.integrate(created.ok ? created.value.id : "");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe("landed");
    const merge = calls.find((args) => args[0] === "merge");
    expect(merge).toEqual(["merge", "--no-ff", "--no-edit", "moh/auto-s1"]);
    expect(service.listLanes(group.id)[0]!.branchRef).toBe("moh/auto-s1");
  });

  test("resolve refuses a lane that is not conflicted", async () => {
    const { cwd, home } = project();
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("kappa", "develop");
    const created = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/kappa-1", baseRef: "develop",
    });
    expect(created.ok).toBe(true);
    const result = await service.resolve(created.ok ? created.value.id : "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("registry");
  });

  test("integrate refuses a lane whose branch is gone", async () => {
    const { cwd, home } = project();
    const { runner } = fakeGit(() => ({ code: 1, stdout: "", stderr: "fatal: bad revision" }));
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const group = await service.ensureFeatureGroup("lambda", "develop");
    const result = await service.integrate("lane-missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("registry");
    expect(service.listLanes(group.id)).toEqual([]);
  });
});

function gitRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "moh-auto-lane-"));
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return cwd;
}

describe("ensureSessionLane (auto-lane, ADR-0060)", () => {
  test("provisions a lane under a group named after the current branch", async () => {
    const cwd = gitRepo();
    const home = mkdtempSync(join(tmpdir(), "h-"));
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "develop\n", stderr: "" };
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const { lane } = await service.ensureSessionLane({ sessionId: "abc123", force: true });
    expect(lane).toBeDefined();
    expect(lane!.branchRef).toBe("moh/auto-abc123");
    expect(lane!.baseRef).toBe("develop");
    expect(lane!.targetRef).toBe("develop");
    expect(lane!.relation).toBe("independent");
    const groups = service.store.listFeatureGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("develop");
  });

  test("a second session reuses the group and gets its own lane", async () => {
    const cwd = gitRepo();
    const home = mkdtempSync(join(tmpdir(), "h-"));
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "develop\n", stderr: "" };
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b1\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    // Lazy: session "one" stays in the checkout; "two" is the first
    // parallel session and gets the lane.
    const first = await service.ensureSessionLane({ sessionId: "one", force: true });
    expect(first.lane).toBeDefined();
    const second = await service.ensureSessionLane({ sessionId: "two" });
    expect(second.lane).toBeDefined();
    expect(second.lane!.branchRef).toBe("moh/auto-two");
    expect(second.lane!.branchRef).toBe("moh/auto-two");
    expect(service.store.listFeatureGroups()).toHaveLength(1);
  });

  test("opt-out via auto:false returns no lane and writes nothing", async () => {
    const cwd = gitRepo();
    const home = mkdtempSync(join(tmpdir(), "h-"));
    const { runner, calls } = fakeGit(() => ({ code: 0, stdout: "", stderr: "" }));
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const { lane } = await service.ensureSessionLane({ sessionId: "x", auto: false });
    expect(lane).toBeNull();
    expect(calls).toEqual([]);
    expect(service.store.listFeatureGroups()).toEqual([]);
  });

  test("a session started inside a lane worktree reuses that lane", async () => {
    const cwd = gitRepo();
    const home = mkdtempSync(join(tmpdir(), "h-"));
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "develop\n", stderr: "" };
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b2\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const { lane } = await service.ensureSessionLane({ sessionId: "r1", force: true });
    // Materialize the worktree the fake runner never created (its .git
    // pointer file is what the reuse check keys on in the real flow). The
    // pointer names the checkout's git dir, as `git worktree add` writes it.
    mkdirSync(lane!.worktreePath, { recursive: true });
    writeFileSync(join(lane!.worktreePath, ".git"), `gitdir: ${join(cwd, ".git", "worktrees", "w1")}\n`);
    // A nested service pointed at the worktree sees the same registry (same
    // home/project) and must reuse the lane instead of nesting.
    const nested = new DevelopmentLaneService({ cwd: lane!.worktreePath, home, git: runner });
    const again = await nested.ensureSessionLane({ sessionId: "r2" });
    expect(again.lane!.id).toBe(lane!.id);
    // mainCheckoutFor: the .git pointer file resolves back to the checkout.
    expect(mainCheckoutFor(lane!.worktreePath)).toBe(cwd);
  });

  test("a detached HEAD stays laneless with a reason", async () => {
    const cwd = gitRepo();
    const home = mkdtempSync(join(tmpdir(), "h-"));
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "HEAD\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const { lane, reason } = await service.ensureSessionLane({ sessionId: "d1", force: true });
    expect(lane).toBeNull();
    expect(reason).toBe("detached HEAD");
  });

  test("shares the checkout's node_modules into the fresh worktree", async () => {
    const cwd = gitRepo();
    mkdirSync(join(cwd, "node_modules"));
    const home = mkdtempSync(join(tmpdir(), "h-"));
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "develop\n", stderr: "" };
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b3\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const { lane } = await service.ensureSessionLane({ sessionId: "nm1", force: true });
    expect(existsSync(join(lane!.worktreePath, "node_modules"))).toBe(true);
  });
});

describe("lazy lanes, labels and cleanup (ADR-0060)", () => {
  function autoRunner() {
    return fakeGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "develop\n", stderr: "" };
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
  }

  test("lazy: the first session stays in the checkout, the second gets a lane", async () => {
    const cwd = gitRepo();
    const home = mkdtempSync(join(tmpdir(), "h-"));
    const { runner } = autoRunner();
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const first = await service.ensureSessionLane({ sessionId: "solo" });
    expect(first.lane).toBeNull();
    expect(first.reason).toBe("lazy: no parallel session yet");
    expect(service.store.listFeatureGroups()).toEqual([]);
    // A live sibling (the client's own open-session count) is parallelism
    // evidence: the second window provisions immediately.
    const second = await service.ensureSessionLane({ sessionId: "par", task: "issue #42", liveSiblingSessions: 1 });
    expect(second.lane).toBeDefined();
    expect(second.lane!.label).toBe("issue #42");
  });

  test("a task label names the lane and survives a resume-in-lane", async () => {
    const cwd = gitRepo();
    const home = mkdtempSync(join(tmpdir(), "h-"));
    const { runner } = autoRunner();
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const first = await service.ensureSessionLane({ sessionId: "a", force: true });
    const again = await service.ensureSessionLane({ sessionId: "b", task: "fix parser", liveSiblingSessions: 1 });
    expect(again.lane!.label).toBe("fix parser");
    expect(first.lane!.label).toBeUndefined();
    // The lane list exposes the label for humans.
    const listed = service.listLanes().find((lane) => lane.id === again.lane!.id);
    expect(listed?.label).toBe("fix parser");
  });

  test("cleanup removes clean stale lanes, keeps dirty ones", async () => {
    const cwd = gitRepo();
    const home = mkdtempSync(join(tmpdir(), "h-"));
    let dirty = false;
    const { runner } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "develop\n", stderr: "" };
      if (args[0] === "rev-parse" && args[2]!.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: dirty ? " M file.ts\n" : "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    const a = await service.ensureSessionLane({ sessionId: "old-clean", force: true, task: "done days ago" });
    const b = await service.ensureSessionLane({ sessionId: "old-dirty", force: true, task: "wip" });
    // Age both lanes past the cutoff.
    const store = service.store;
    for (const lane of store.listLanes()) {
      store.setLabel(lane.id, lane.label ?? "");
      // Rewind updatedAt by touching status twice with an aged state: use
      // the public seam — setStatus refreshes updatedAt, so age via label
      // write is not enough. Instead: write state directly through setStatus
      // then rewind the file timestamp by patching via a second setLabel.
      void lane;
    }
    // Simplest honest aging: bypass service with an old copy of the state.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const file = store.file;
    const aged = JSON.parse(readFileSync(file, "utf8"));
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    for (const lane of aged.lanes) lane.updatedAt = old;
    writeFileSync(file, JSON.stringify(aged, null, 2));
    void a; void b;

    // Dry run first.
    const dry = await service.cleanup({ minAgeDays: 7, apply: false });
    expect(dry.ok && dry.value.removed).toHaveLength(2);
    expect(store.listLanes().filter((l) => l.status === "active")).toHaveLength(2);

    // Dirty lanes survive; clean ones go. Note: with the fake runner the
    // worktrees are never materialized, so `worktreeExists` is false and
    // both lanes take the missing-worktree removal path — dirty detection
    // needs the worktree to exist. Materialize both first.
    for (const lane of store.listLanes()) {
      mkdirSync(lane.worktreePath, { recursive: true });
      writeFileSync(join(lane.worktreePath, ".git"), "gitdir: /x\n");
    }
    dirty = true;
    const report = await service.cleanup({ minAgeDays: 7, apply: true });
    expect(report.ok && report.value.removed).toHaveLength(0);
    expect(report.ok && report.value.kept).toHaveLength(2);
    dirty = false;
    const final = await service.cleanup({ minAgeDays: 7, apply: true });
    expect(final.ok && final.value.removed).toHaveLength(2);
    expect(store.listLanes().filter((l) => l.status === "active")).toHaveLength(0);
  });
});

describe("service.remove (registry-only single-lane removal)", () => {
  function setup() {
    const { cwd, home } = project();
    const { runner, calls } = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[2]?.startsWith("refs/heads/")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "b4se000\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new DevelopmentLaneService({ cwd, home, git: runner });
    return { cwd, service, calls };
  }

  test("refuses a lane with a live worktree or a non-terminal status", async () => {
    const { service, calls } = setup();
    const group = await service.ensureFeatureGroup("alpha", "develop");
    const result = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/alpha-9", baseRef: "develop",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refused = await service.remove(result.value.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(["worktree-exists", "registry"]).toContain(refused.error.kind);
    expect(service.listLanes()).toHaveLength(1);
    expect(calls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
  });

  test("removes an abandoned lane's row with no git effects", async () => {
    const { service, calls } = setup();
    const group = await service.ensureFeatureGroup("alpha", "develop");
    const result = await service.createWorktreeLane({
      featureGroupId: group.id, sessionId: "s1", branchRef: "feature/alpha-10", baseRef: "develop",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await service.setStatus(result.value.id, "abandoned");
    const gitCalls = calls.length;
    const removed = await service.remove(result.value.id);
    expect(removed.ok).toBe(true);
    expect(service.listLanes()).toEqual([]);
    expect(calls.length).toBe(gitCalls);
  });
});
