import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentLaneStore } from "../src/index";

function project(): { cwd: string; home: string } {
  return {
    cwd: mkdtempSync(join(tmpdir(), "moh-lanes-project-")),
    home: mkdtempSync(join(tmpdir(), "moh-lanes-home-")),
  };
}

describe("development lane store", () => {
  test("persists a feature group and isolated independent lanes", () => {
    const { cwd, home } = project();
    const store = new DevelopmentLaneStore({ cwd, home });
    const group = store.createFeatureGroup({ name: "authentication", targetRef: "develop" });
    const lane = store.createLane({
      featureGroupId: group.id,
      sessionId: "session-a",
      worktreePath: "/tmp/auth-a",
      branchRef: "feature/auth-a",
      baseRef: "develop",
      baseRevision: "abc123",
      targetRef: "develop",
      relation: "independent",
    });

    expect(store.listFeatureGroups()).toEqual([expect.objectContaining({ id: group.id, name: "authentication" })]);
    expect(store.listLanes(group.id)).toEqual([expect.objectContaining({
      id: lane.id,
      relation: "independent",
      baseRevision: "abc123",
      status: "active",
    })]);
    expect(existsSync(store.file)).toBe(true);
    expect(JSON.parse(readFileSync(store.file, "utf8")).version).toBe(1);
  });

  test("requires a parent lane for dependent work and keeps it in the same group", () => {
    const { cwd, home } = project();
    const store = new DevelopmentLaneStore({ cwd, home });
    const group = store.createFeatureGroup({ name: "payments", targetRef: "develop" });
    expect(() => store.createLane({
      featureGroupId: group.id,
      sessionId: "session-a",
      worktreePath: "/tmp/payments-a",
      branchRef: "feature/payments-a",
      baseRef: "develop",
      baseRevision: "abc",
      targetRef: "develop",
      relation: "depends-on",
    })).toThrow("parentLaneId");

    const parent = store.createLane({
      featureGroupId: group.id,
      sessionId: "session-a",
      worktreePath: "/tmp/payments-a",
      branchRef: "feature/payments-a",
      baseRef: "develop",
      baseRevision: "abc",
      targetRef: "develop",
      relation: "independent",
    });
    const child = store.createLane({
      featureGroupId: group.id,
      sessionId: "session-b",
      worktreePath: "/tmp/payments-b",
      branchRef: "feature/payments-b",
      baseRef: parent.branchRef,
      baseRevision: "parent-tip",
      targetRef: "develop",
      relation: "depends-on",
      parentLaneId: parent.id,
    });
    expect(child.parentLaneId).toBe(parent.id);
  });

  test("rejects duplicate active worktrees and sessions", () => {
    const { cwd, home } = project();
    const store = new DevelopmentLaneStore({ cwd, home });
    const group = store.createFeatureGroup({ name: "search", targetRef: "develop" });
    const input = {
      featureGroupId: group.id,
      sessionId: "session-a",
      worktreePath: "/tmp/search-a",
      branchRef: "feature/search-a",
      baseRef: "develop",
      baseRevision: "abc",
      targetRef: "develop",
      relation: "independent" as const,
    };
    store.createLane(input);
    expect(() => store.createLane({ ...input, branchRef: "feature/search-b", sessionId: "session-b" })).toThrow("worktree");
    expect(() => store.createLane({ ...input, worktreePath: "/tmp/search-b", branchRef: "feature/search-b" })).toThrow("session");
  });

  test("allows a new lane to reuse a released worktree and persists status", () => {
    const { cwd, home } = project();
    const store = new DevelopmentLaneStore({ cwd, home });
    const group = store.createFeatureGroup({ name: "docs", targetRef: "develop" });
    const first = store.createLane({
      featureGroupId: group.id, sessionId: "session-a", worktreePath: "/tmp/docs", branchRef: "feature/docs-a",
      baseRef: "develop", baseRevision: "abc", targetRef: "develop", relation: "independent",
    });
    store.setStatus(first.id, "landed");
    const second = store.createLane({
      featureGroupId: group.id, sessionId: "session-b", worktreePath: "/tmp/docs", branchRef: "feature/docs-b",
      baseRef: "develop", baseRevision: "def", targetRef: "develop", relation: "independent",
    });
    expect(second.status).toBe("active");
  });
});

describe("removeLane (single-lane registry removal)", () => {
  test("deletes exactly one lane row and leaves the rest intact", () => {
    const { cwd, home } = project();
    const store = new DevelopmentLaneStore({ cwd, home });
    const group = store.createFeatureGroup({ name: "g", targetRef: "develop" });
    const a = store.createLane({
      featureGroupId: group.id, sessionId: "s-a", worktreePath: "/tmp/a",
      branchRef: "feature/a", baseRef: "develop", baseRevision: "abc", targetRef: "develop", relation: "independent",
    });
    const b = store.createLane({
      featureGroupId: group.id, sessionId: "s-b", worktreePath: "/tmp/b",
      branchRef: "feature/b", baseRef: "develop", baseRevision: "abc", targetRef: "develop", relation: "independent",
    });
    const removed = store.removeLane(a.id);
    expect(removed.id).toBe(a.id);
    expect(store.listLanes().map((l) => l.id)).toEqual([b.id]);
    expect(() => store.removeLane(a.id)).toThrow(`unknown lane: ${a.id}`);
  });
});
