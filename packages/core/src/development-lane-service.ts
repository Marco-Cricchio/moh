import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DevelopmentLaneStore, type DevelopmentLane, type LaneRelation, type LaneStatus } from "./development-lanes";


/** One Git invocation result, normalized for the lane lifecycle. */
export interface LaneGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable Git runner (tests pass a fake); default spawns `git`. */
export type LaneGitRunner = (args: string[], options: { cwd: string }) => Promise<LaneGitResult>;

/** Default Git runner: `git -C <cwd> <args…>` with piped stdio. */
export const defaultLaneGitRunner: LaneGitRunner = async (args, options) => {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(["git", "-C", options.cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export interface LaneServiceOptions {
  /** Project root: the main checkout that owns the lane worktrees. */
  cwd: string;
  /** Injectable home for tests and alternate clients. */
  home?: string;
  /** Injectable Git runner (tests); default spawns the `git` CLI. */
  git?: LaneGitRunner;
}

export interface CreateWorktreeLaneInput {
  featureGroupId: string;
  sessionId: string;
  /** Branch for the new lane; created from the resolved base revision. */
  branchRef: string;
  /** Ref the lane branches from (e.g. `develop` or a parent lane's branch). */
  baseRef: string;
  /** Only meaningful for `depends-on` lanes. */
  parentLaneId?: string;
}

/** Why a lane Git operation failed, normalized for clients. */
export type LaneOperationError =
  | { kind: "not-a-repo"; message: string }
  | { kind: "unknown-ref"; message: string }
  | { kind: "branch-exists"; message: string }
  | { kind: "worktree-exists"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "registry"; message: string }
  | { kind: "git"; message: string };

export type LaneOperationResult<T> = { ok: true; value: T } | { ok: false; error: LaneOperationError };

function fail(kind: LaneOperationError["kind"], message: string): { ok: false; error: LaneOperationError } {
  return { ok: false, error: { kind, message } };
}

/**
 * Git-backed lifecycle on top of the persistent lane registry: creates the
 * worktree and branch a lane declares, detects missing worktrees, and
 * records the resolved base revision. The registry stays the source of
 * truth; this service only performs what the registry already describes.
 */
export class DevelopmentLaneService {
  readonly #store: DevelopmentLaneStore;
  readonly #cwd: string;
  readonly #git: LaneGitRunner;

  constructor(options: LaneServiceOptions) {
    this.#cwd = options.cwd;
    this.#store = new DevelopmentLaneStore({ cwd: options.cwd, home: options.home });
    this.#git = options.git ?? defaultLaneGitRunner;
  }

  get store(): DevelopmentLaneStore {
    return this.#store;
  }

  listLanes(featureGroupId?: string): DevelopmentLane[] {
    return this.#store.listLanes(featureGroupId);
  }

  /** Creates the feature group if absent, returning the existing one on a name match. */
  async ensureFeatureGroup(name: string, targetRef: string) {
    const existing = this.#store.listFeatureGroups().find((group) => group.name === name.trim());
    if (existing) return existing;
    return this.#store.createFeatureGroup({ name, targetRef });
  }

  /**
   * Resolves `baseRef` to its exact current revision (invariant 3), then
   * creates the branch and worktree and registers the lane. Registry-side
   * collisions are checked before any Git write; Git-side conflicts are
   * reported without partial registry state.
   */
  async createWorktreeLane(input: CreateWorktreeLaneInput): Promise<LaneOperationResult<DevelopmentLane>> {
    if (!existsSync(join(this.#cwd, ".git"))) {
      return fail("not-a-repo", `not a git repository: ${this.#cwd}`);
    }
    const base = await this.#git(["rev-parse", "--verify", `${input.baseRef}^{commit}`], { cwd: this.#cwd });
    if (base.code !== 0) {
      return fail("unknown-ref", `cannot resolve base ref "${input.baseRef}": ${base.stderr.trim()}`);
    }
    const branchCheck = await this.#git(["rev-parse", "--verify", `refs/heads/${input.branchRef}`], { cwd: this.#cwd });
    if (branchCheck.code === 0) {
      return fail("branch-exists", `branch already exists: ${input.branchRef}`);
    }
    // A relation/pair the registry would refuse (duplicate session, active
    // worktree, missing parent) must fail before any Git write happens.
    const relation: LaneRelation = input.parentLaneId ? "depends-on" : "independent";
    const worktreePath = join(this.#cwd, "..", laneWorktreeDirName(input.branchRef));
    const probe = this.#store.probeLane({
      featureGroupId: input.featureGroupId,
      sessionId: input.sessionId,
      worktreePath,
      branchRef: input.branchRef,
      baseRef: input.baseRef,
      baseRevision: base.stdout.trim(),
      targetRef: await this.targetRefOf(input.featureGroupId),
      relation,
      parentLaneId: input.parentLaneId,
    });
    if (!probe.ok) return probe;
    const add = await this.#git(
      ["worktree", "add", "-b", input.branchRef, worktreePath, base.stdout.trim()],
      { cwd: this.#cwd },
    );
    if (add.code !== 0) {
      const message = add.stderr.trim();
      if (message.includes("already exists")) {
        return fail("worktree-exists", message);
      }
      return fail("git", message);
    }
    let created: DevelopmentLane;
    try {
      created = this.#store.createLane({
        featureGroupId: input.featureGroupId,
        sessionId: input.sessionId,
        worktreePath,
        branchRef: input.branchRef,
        baseRef: input.baseRef,
        baseRevision: base.stdout.trim(),
        targetRef: probe.value.targetRef,
        relation,
        ...(input.parentLaneId ? { parentLaneId: input.parentLaneId } : {}),
      });
    } catch (error) {
      // The Git write succeeded but the registry refused (a race): report
      // it visibly — the worktree exists and the caller can abandon it.
      return fail("registry", error instanceof Error ? error.message : String(error));
    }
    return { ok: true, value: created };
  }

  /** The feature group's declared target ref; "develop" when unknown. */
  async targetRefOf(featureGroupId: string): Promise<string> {
    const group = this.#store.listFeatureGroups().find((candidate) => candidate.id === featureGroupId);
    return group?.targetRef ?? "develop";
  }

  /**
   * Marks a lane stale-adjacent state: returns whether the lane's recorded
   * base revision is still what its `baseRef` points at. A moved ref does
   * not rewrite the lane (invariant 5); the caller decides what to do.
   */
  async freshness(laneId: string): Promise<LaneOperationResult<{ stale: boolean; currentRevision: string | null }>> {
    const lane = this.#store.listLanes().find((candidate) => candidate.id === laneId);
    if (!lane) return fail("registry", `unknown lane: ${laneId}`);
    const current = await this.#git(["rev-parse", "--verify", `${lane.baseRef}^{commit}`], { cwd: this.#cwd });
    if (current.code !== 0) {
      return { ok: true, value: { stale: true, currentRevision: null } };
    }
    const revision = current.stdout.trim();
    return { ok: true, value: { stale: revision !== lane.baseRevision, currentRevision: revision } };
  }

  /** True when the lane's worktree directory still exists on disk. */
  worktreeExists(lane: Pick<DevelopmentLane, "worktreePath">): boolean {
    return existsSync(join(lane.worktreePath, ".git"));
  }

  /** Lists lanes with their worktree health and base freshness resolved. */
  async inspect(laneId: string): Promise<LaneOperationResult<{
    lane: DevelopmentLane;
    worktreePresent: boolean;
    stale: boolean;
    currentBaseRevision: string | null;
  }>> {
    const lane = this.#store.listLanes().find((candidate) => candidate.id === laneId);
    if (!lane) return fail("registry", `unknown lane: ${laneId}`);
    const freshness = await this.freshness(laneId);
    if (!freshness.ok) return freshness;
    return {
      ok: true,
      value: {
        lane,
        worktreePresent: this.worktreeExists(lane),
        stale: freshness.value.stale,
        currentBaseRevision: freshness.value.currentRevision,
      },
    };
  }

  /** Removes the worktree, deletes the branch, and marks the lane abandoned. */
  async abandon(laneId: string): Promise<LaneOperationResult<DevelopmentLane>> {
    const lane = this.#store.listLanes().find((candidate) => candidate.id === laneId);
    if (!lane) return fail("registry", `unknown lane: ${laneId}`);
    if (["landed", "abandoned"].includes(lane.status)) return { ok: true, value: lane };
    const remove = await this.#git(["worktree", "remove", "--force", lane.worktreePath], { cwd: this.#cwd });
    if (remove.code !== 0 && this.worktreeExists(lane)) {
      return fail("git", remove.stderr.trim());
    }
    const branch = await this.#git(["branch", "-D", lane.branchRef], { cwd: this.#cwd });
    if (branch.code !== 0) {
      return fail("git", branch.stderr.trim());
    }
    return { ok: true, value: this.#store.setStatus(laneId, "abandoned") };
  }

  /** Transitions a lane into a status, validating the worktree when required. */
  async setStatus(laneId: string, status: LaneStatus): Promise<LaneOperationResult<DevelopmentLane>> {
    const lane = this.#store.listLanes().find((candidate) => candidate.id === laneId);
    if (!lane) return fail("registry", `unknown lane: ${laneId}`);
    if (["active", "paused", "ready", "integrating", "conflicted"].includes(status) && !this.worktreeExists(lane)) {
      return fail("worktree-exists", `lane worktree is missing: ${lane.worktreePath}`);
    }
    return { ok: true, value: this.#store.setStatus(laneId, status) };
  }
}

/** Directory name for a lane's worktree, derived from its branch ref. */
export function laneWorktreeDirName(branchRef: string): string {
  const safe = branchRef.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `.moh-lanes/${safe || "lane"}`;
}

/** Resolves a lane worktree path to an absolute path under the project's parent. */
export function resolveWorktreePath(cwd: string, branchRef: string): string {
  if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
  const root = dirname(cwd);
  return resolve(root, laneWorktreeDirName(branchRef));
}
