import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentLaneService, resolveWorktreePath, type LaneGitRunner, type LaneGitResult } from "../src/index";

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
      expect(result.value.worktreePath).toBe(resolveWorktreePath(cwd, "feature/alpha-1"));
    }
    const add = calls.find((args) => args[0] === "worktree");
    expect(add).toBeDefined();
    expect(add).toEqual(["worktree", "add", "-b", "feature/alpha-1", resolveWorktreePath(cwd, "feature/alpha-1"), "b4se000"]);
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
});
