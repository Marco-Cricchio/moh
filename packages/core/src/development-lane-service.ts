import { existsSync, lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { projectSessionsDir } from "./session-store";
import { readUserConfigFile, userConfigFile } from "./user-config";
import { DevelopmentLaneStore, type DevelopmentLane, type LaneRelation, type LaneStatus } from "./development-lanes";
import {
  detectLaneSetup,
  foreignStore,
  foreignWorkspaceLinks,
  installLaneDependencies,
  laneOwnsInstall,
  removeForeignStore,
  sameInstallOutcome,
  type LaneInstallOutcome,
  type LaneInstallRunner,
} from "./lane-install";


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
  /** The `lanes.setup` user-config key (ADR-0060 amendment 5): the last
   * word on what a lane installs — a command, or `false` for a project
   * that has nothing to install. Undefined falls back to the project's
   * own declaration. */
  setup?: string | false;
  /** Injectable dependency installer (tests); default spawns a shell. */
  install?: LaneInstallRunner;
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
  | { kind: "install"; message: string }
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
  /** Injectable home (tests); owns the lane worktree root too. */
  readonly #home: string;
  /** Where the session actually runs (a lane worktree or the checkout). */
  readonly #sessionCwd: string;
  readonly #git: LaneGitRunner;
  /** The `lanes.setup` last word, resolved by the client. */
  readonly #setup: string | false | undefined;
  readonly #install: LaneInstallRunner | undefined;

  constructor(options: LaneServiceOptions) {
    // A service constructed inside a lane worktree is remapped to the main
    // checkout: the registry is per-project (origin/uuid slug) and a
    // worktree resolves a different identity — and every Git write
    // (worktree add, merge, branch -D) belongs to the main checkout,
    // never to a lane's own checkout.
    this.#cwd = mainCheckoutFor(options.cwd) ?? options.cwd;
    this.#home = options.home ?? homedir();
    this.#sessionCwd = options.cwd;
    this.#store = new DevelopmentLaneStore({ cwd: this.#cwd, home: options.home });
    this.#git = options.git ?? defaultLaneGitRunner;
    this.#setup = options.setup;
    this.#install = options.install;
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
    const worktreePath = resolveWorktreePath(this.#cwd, input.branchRef, this.#home);
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
    // The install is the last step before the lane is usable (ADR-0060
    // amendment 5): the lane exists either way, its outcome is on the row.
    const ensured = await this.#ensureLaneInstall(created);
    return { ok: true, value: ensured.lane };
  }

  /**
   * Ensures a lane owns its dependency install: the install the project
   * declares, run in the lane's own worktree (ADR-0060 amendment 5). A
   * store that is not the lane's own — the removed checkout symlink,
   * foreign workspace links, a missing install, a previous failure — is
   * discarded before that install: installing *through* a foreign store
   * would write into the checkout (or another lane), which is the very
   * failure this replaced. The outcome is recorded on the lane row and
   * returned when it is news: a failure, or a first visible
   * nothing-to-install reason (reported once, not on every open).
   */
  async #ensureLaneInstall(lane: DevelopmentLane): Promise<{ lane: DevelopmentLane; install?: LaneInstallOutcome }> {
    const detection = detectLaneSetup(lane.worktreePath, this.#setup);
    if (detection.kind === "nothing") {
      // Nothing to run, nothing to report unless a manifest is present and
      // unrecognized — and even then only the first time.
      if (!detection.reason) return { lane };
      const outcome: LaneInstallOutcome = { kind: "nothing", at: new Date().toISOString(), reason: detection.reason };
      if (sameInstallOutcome(lane.install, outcome)) return { lane };
      const recorded = this.#store.setInstall(lane.id, outcome);
      return { lane: recorded, install: outcome };
    }
    // Already this lane's own, from a successful install: nothing pending.
    if (laneOwnsInstall(lane.worktreePath) && lane.install?.kind === "installed") return { lane };
    // A store that is not the lane's own is never installed through: the
    // foreign directory (a symlink to the checkout's install, a worktree
    // a previous lane lay under) goes first, so the install lands here.
    removeForeignStore(lane.worktreePath);
    const outcome = await installLaneDependencies({
      worktreePath: lane.worktreePath,
      setup: this.#setup,
      ...(this.#install ? { runner: this.#install } : {}),
    });
    return { lane: this.#store.setInstall(lane.id, outcome), install: outcome };
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

  /**
   * Deletes one lane outright (ADR-0060 amendment 3): worktree, branch,
   * registry row — the destructive counterpart of `abandon` that leaves
   * nothing behind, not even the registry row. `deleteWorktree` (default
   * true) removes the directory from disk with the committed-work caveat
   * (`git worktree remove --force` discards uncommitted changes and the
   * branch delete drops unlanded commits); `false` degenerates to the
   * registry-only form. Never fails on an already-missing worktree.
   */
  async deleteLane(laneId: string, options: { deleteWorktree?: boolean } = {}): Promise<LaneOperationResult<DevelopmentLane>> {
    const lane = this.#store.listLanes().find((candidate) => candidate.id === laneId);
    if (!lane) return fail("registry", `unknown lane: ${laneId}`);
    if (options.deleteWorktree === false) return this.remove(laneId, { force: true });
    if (this.worktreeExists(lane)) {
      const remove = await this.#git(["worktree", "remove", "--force", lane.worktreePath], { cwd: this.#cwd });
      if (remove.code !== 0 && this.worktreeExists(lane)) {
        return fail("git", remove.stderr.trim());
      }
    }
    const branch = await this.#git(["branch", "-D", lane.branchRef], { cwd: this.#cwd });
    if (branch.code !== 0) {
      return fail("git", branch.stderr.trim());
    }
    return { ok: true, value: this.#store.removeLane(laneId) };
  }

  /**
   * Removes a single lane from the registry without touching git
   * (registry-only): the door for pruning a lane whose worktree and
   * branch are already gone. Refuses a lane with a live worktree or a
   * non-terminal status unless `force` — abandon first for lanes that
   * still own git state, the registry row is not a substitute for it.
   */
  async remove(laneId: string, options: { force?: boolean } = {}): Promise<LaneOperationResult<DevelopmentLane>> {
    const lane = this.#store.listLanes().find((candidate) => candidate.id === laneId);
    if (!lane) return fail("registry", `unknown lane: ${laneId}`);
    if (!options.force) {
      if (this.worktreeExists(lane)) {
        return fail("worktree-exists", `lane worktree still present: ${lane.worktreePath} — abandon it first, or pass force`);
      }
      if (!["landed", "abandoned"].includes(lane.status)) {
        return fail("registry", `lane is ${lane.status} — abandon it first, or pass force to drop the registry row`);
      }
    }
    return { ok: true, value: this.#store.removeLane(laneId) };
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

  /**
   * Lazy lanes (ADR-0060 amendment): the checkout itself is the first
   * workspace — provisioning starts only when a parallel lane already
   * exists (or `force` is set). No orphan lanes for generic or
   * single-session work; no disk, startup or registry cost without
   * parallelism.
   *
   * - disabled by config (`lanes.auto: false`) or a non-repo/detached cwd
   *   → a laneless session, exactly the pre-lane behavior;
   * - the cwd is already inside a lane worktree → that lane is reused
   *   (resume-in-lane, nested clients);
   * - zero active lanes and no `force` → laneless ("lazy");
   * - otherwise: feature group derived from the checkout's current branch
   *   (its target), one lane per session on a `moh/<session>` branch,
   *   default relation `independent` (same feature never implies
   *   dependency — the user can stack later via `moh lanes`);
   * - `task` names the lane (issue id / task slug) so a stale lane is
   *   identifiable weeks later;
   * - the lane installs its own dependencies (ADR-0060 amendment 5): the
   *   project's declared install runs in the lane's worktree as the last
   *   provisioning step, and a lane whose `node_modules` is not its own
   *   converts to one. Nothing is shared with the checkout.
   *
   * Failure is non-fatal by design: a lane problem degrades to a plain
   * session and the reason is returned for one visible notice. A failed
   * install keeps the lane and is reported through `install`.
   */
  async ensureSessionLane(options: {
    /** Stable session correlation for the lane record and branch name. */
    sessionId: string;
    /** `lanes.auto` from the user config (default: true). */
    auto?: boolean;
    /** What the session is working on — labels the lane for humans. */
    task?: string;
    /** Provision even with zero active lanes (explicit door, `moh lanes start`). */
    force?: boolean;
    /** Live sibling sessions of this project the client already knows
     * about (its open-session count minus itself). Evidence of parallelism
     * for the lazy check, without registry state. */
    liveSiblingSessions?: number;
  }): Promise<{ lane: DevelopmentLane | null; reason?: string; install?: LaneInstallOutcome }> {
    if (options.auto === false) return { lane: null };
    // Inside an existing lane worktree: reuse it — never nest lanes.
    // (Checked against the SESSION cwd — the constructor remaps #cwd to the
    // main checkout for registry/Git ownership — and before repo-ness: a
    // worktree's .git is a pointer file the caller may not have
    // materialized yet.)
    const existing = this.#store.listLanes().find(
      (candidate) => candidate.status === "active" && (candidate.worktreePath === this.#sessionCwd || this.#sessionCwd.startsWith(candidate.worktreePath + "/")),
    );
    if (existing) {
      // A session that opens with a task in hand names its lane — the
      // label is what makes a stale lane identifiable later.
      if (options.task) this.#store.setLabel(existing.id, options.task);
      const ensured = await this.#ensureLaneInstall(existing);
      return { lane: ensured.lane, ...(ensured.install ? { install: ensured.install } : {}) };
    }
    if (!existsSync(join(this.#cwd, ".git"))) {
      return { lane: null, reason: "not a git repository" };
    }
    // Lazy lanes: the checkout itself is the workspace while there is no
    // evidence of parallel work. Evidence = active lanes (kept alive by
    // earlier parallel sessions) OR a caller-supplied signal that another
    // session of this project is live (`liveSiblingSessions`: the client
    // knows its open-session count). No inference, no questions — just
    // observable activity.
    const activeLanes = this.#store.listLanes().filter((candidate) => !["landed", "abandoned"].includes(candidate.status));
    const parallelEvidence = activeLanes.length > 0 || (options.liveSiblingSessions ?? 0) > 0;
    if (!parallelEvidence && !options.force) {
      return { lane: null, reason: "lazy: no parallel session yet" };
    }
    const head = await this.#git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.#cwd });
    const branch = head.stdout.trim();
    if (head.code !== 0 || !branch || branch === "HEAD") {
      return { lane: null, reason: "detached HEAD" };
    }
    let group = this.#store.listFeatureGroups().find((candidate) => candidate.targetRef === branch);
    if (!group) {
      try {
        group = await this.ensureFeatureGroup(branch, branch);
      } catch {
        // A same-name group with a different target: qualify with the target.
        group = await this.ensureFeatureGroup(`${branch}-work`, branch);
      }
    }
    const sessionId = `auto-${options.sessionId}`;
    const branchRef = `moh/${sessionId}`.slice(0, 80);
    // The active lane for this session id is the reuse path: a retried
    // open (or a client that calls provisioning twice) gets the same lane.
    const mine = this.#store.listLanes().find(
      (candidate) => candidate.sessionId === sessionId && !["landed", "abandoned"].includes(candidate.status),
    );
    if (mine && this.worktreeExists(mine)) {
      const current = options.task ? this.#store.setLabel(mine.id, options.task) : mine;
      const ensured = await this.#ensureLaneInstall(current);
      return { lane: ensured.lane, ...(ensured.install ? { install: ensured.install } : {}) };
    }
    const result = await this.createWorktreeLane({
      featureGroupId: group.id,
      sessionId,
      branchRef,
      baseRef: branch,
    });
    if (!result.ok) {
      // A branch that already exists (same session id retried): reuse the
      // registered lane if one is active for that branch.
      const registered = this.#store.listLanes().find(
        (candidate) => candidate.branchRef === branchRef && !["landed", "abandoned"].includes(candidate.status),
      );
      if (registered && this.worktreeExists(registered)) {
        if (options.task) this.#store.setLabel(registered.id, options.task);
        const ensured = await this.#ensureLaneInstall(registered);
        return { lane: ensured.lane, ...(ensured.install ? { install: ensured.install } : {}) };
      }
      return { lane: null, reason: result.error.message };
    }
    // Name the lane after the work: the issue id / task slug is what an
    // old lane is recognized by weeks later.
    const labeled = options.task ? this.#store.setLabel(result.value.id, options.task) : result.value;
    return { lane: labeled, ...(labeled.install ? { install: labeled.install } : {}) };
  }

  /**
   * Stale-lane cleanup: a lane older than `minAgeDays` whose worktree has
   * NO uncommitted changes is removable — its commits live on the branch
   * and its noise lives in the registry. Dirty lanes are reported but
   * never touched (deleting uncommitted work is always the user's call).
   * `apply: false` is a dry run the clients surface as a suggestion.
   */
  async cleanup(options: CleanupOptions = {}): Promise<LaneOperationResult<CleanupReport>> {
    const minAgeDays = options.minAgeDays ?? 7;
    const apply = options.apply ?? true;
    const cutoff = Date.now() - minAgeDays * 24 * 3600 * 1000;
    const report: CleanupReport = { removed: [], kept: [] };
    for (const lane of this.#store.listLanes()) {
      if (["landed", "abandoned"].includes(lane.status)) continue;
      const updatedAt = Date.parse(lane.updatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt > cutoff) continue;
      if (!this.worktreeExists(lane)) {
        // A missing worktree means nothing is left to lose on disk; the
        // registry row is the only residue.
        if (apply) report.removed.push(this.#store.setStatus(lane.id, "abandoned"));
        else report.removed.push(lane);
        continue;
      }
      const status = await this.#git(["status", "--porcelain"], { cwd: lane.worktreePath });
      const dirty = status.code !== 0 || status.stdout.trim() !== "";
      if (dirty) {
        report.kept.push({ lane, ageDays: Math.floor((Date.now() - updatedAt) / 86_400_000), dirty });
        continue;
      }
      if (!apply) {
        report.removed.push(lane);
        continue;
      }
      const removed = await this.abandon(lane.id);
      if (removed.ok) report.removed.push(removed.value);
      else report.kept.push({ lane, ageDays: Math.floor((Date.now() - updatedAt) / 86_400_000), dirty: false });
    }
    return { ok: true, value: report };
  }

  /**
   * Read-only drift check on the checkout's own install (ADR-0060
   * amendment 5, never a mutation): the checkout and every lane used to
   * resolve `@moh/*` to whichever lane ran the last `bun install`. A
   * satisfied foreign link is not repaired by reinstalling, so the check
   * names the method the repair door runs.
   */
  checkoutInstallDrift(): LaneInstallDrift {
    const store = join(this.#cwd, "node_modules");
    if (!existsSync(store)) return { checkoutPath: this.#cwd, drifted: false, symlinked: false, foreign: [] };
    const symlinked = foreignStore(this.#cwd);
    const foreign = foreignWorkspaceLinks(this.#cwd);
    return { checkoutPath: this.#cwd, drifted: symlinked || foreign.length > 0, symlinked: lstatSync(store).isSymbolicLink(), foreign };
  }

  /**
   * The repair door for a drifted checkout: dry run by default, applying
   * only on request. The method is the one that works — remove the
   * workspace links and reinstall; a plain `bun install` does not repair a
   * satisfied foreign link.
   */
  async repairCheckoutInstall(options: { apply?: boolean } = {}): Promise<LaneOperationResult<LaneInstallRepair>> {
    const drift = this.checkoutInstallDrift();
    const detection = detectLaneSetup(this.#cwd, this.#setup);
    const repair: LaneInstallRepair = {
      ...drift,
      command: detection.kind === "install" ? detection.command : null,
      applied: false,
    };
    if (!drift.drifted || options.apply !== true) return { ok: true, value: repair };
    const links = join(this.#cwd, "node_modules", "@moh");
    try {
      if (existsSync(links)) rmSync(links, { recursive: true, force: true });
    } catch (error) {
      return fail("install", `cannot remove the workspace links: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (detection.kind === "install") {
      const outcome = await installLaneDependencies({
        worktreePath: this.#cwd,
        setup: this.#setup,
        ...(this.#install ? { runner: this.#install } : {}),
      });
      if (outcome.kind === "failed") {
        return fail("install", `reinstall failed: ${outcome.reason}`);
      }
    }
    return { ok: true, value: { ...repair, applied: true } };
  }

  /**
   * The branch the lane's worktree actually has checked out. Agents create
   * semantic branches inside a lane at commit time, so the registry
   * `branchRef` (the auto-provisioned name) can sit empty at the base
   * revision while the real work lives elsewhere — git is the source for
   * what is checked out; the registry is updated as provenance. Falls back
   * to the registry ref when the worktree is missing, detached, unreadable,
   * or points at a branch the main checkout does not know.
   */
  async #liveLaneBranch(lane: DevelopmentLane): Promise<string> {
    if (!this.worktreeExists(lane)) return lane.branchRef;
    const current = await this.#git(["branch", "--show-current"], { cwd: lane.worktreePath });
    const branch = current.stdout.trim();
    if (current.code !== 0 || !branch || branch === lane.branchRef) return lane.branchRef;
    const verify = await this.#git(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: this.#cwd });
    if (verify.code !== 0) return lane.branchRef;
    this.#store.setBranchRef(lane.id, branch);
    return branch;
  }

  /**
   * Explicit integration: merge the lane's branch into the target ref in
   * the MAIN checkout (invariant 8: serialized against one worktree, never
   * a child's). On conflict the merge is aborted in the target and the lane
   * enters a resumable `conflicted` state carrying source and target
   * revisions (invariant 6). Never pushes (invariant 5's corollary: the
   * client decides what happens to the remote).
   */
  async integrate(laneId: string): Promise<LaneOperationResult<{ outcome: "landed"; lane: DevelopmentLane } | { outcome: "conflicted"; conflict: LaneConflict }>> {
    const lane = this.#store.listLanes().find((candidate) => candidate.id === laneId);
    if (!lane) return fail("registry", `unknown lane: ${laneId}`);
    if (["landed", "abandoned"].includes(lane.status)) {
      return fail("registry", `lane is already ${lane.status}: ${laneId}`);
    }
    const branchRef = await this.#liveLaneBranch(lane);
    const branch = await this.#git(["rev-parse", "--verify", `refs/heads/${branchRef}`], { cwd: this.#cwd });
    if (branch.code !== 0) {
      return fail("unknown-ref", `lane branch is missing: ${branchRef}`);
    }
    const target = await this.#git(["rev-parse", "--verify", `${lane.targetRef}^{commit}`], { cwd: this.#cwd });
    if (target.code !== 0) {
      return fail("unknown-ref", `cannot resolve target ref "${lane.targetRef}": ${target.stderr.trim()}`);
    }
    const merge = await this.#git(["merge", "--no-ff", "--no-edit", branchRef], { cwd: this.#cwd });
    if (merge.code === 0) {
      return { ok: true, value: { outcome: "landed" as const, lane: this.#store.setStatus(laneId, "landed") } };
    }
    // Conflict: undo the in-progress merge in the main checkout — the
    // conflict belongs to the LANE as resumable state, not to the target.
    await this.#git(["merge", "--abort"], { cwd: this.#cwd });
    const laneHead = await this.#git(["rev-parse", "--verify", `refs/heads/${branchRef}`], { cwd: this.#cwd });
    this.#store.setStatus(laneId, "conflicted");
    return {
      ok: true,
      value: {
        outcome: "conflicted" as const,
        conflict: {
          laneId,
          operation: "integrate" as const,
          targetRef: lane.targetRef,
          targetRevision: target.stdout.trim(),
          laneRevision: laneHead.code === 0 ? laneHead.stdout.trim() : "",
        },
      },
    };
  }

  /**
   * Retries the last conflicted integration after the user resolved the
   * conflict markers in the lane's worktree: merge the updated lane branch
   * into the target again. Only a `conflicted` lane may resolve.
   */
  async resolve(laneId: string): Promise<LaneOperationResult<DevelopmentLane>> {
    const lane = this.#store.listLanes().find((candidate) => candidate.id === laneId);
    if (!lane) return fail("registry", `unknown lane: ${laneId}`);
    if (lane.status !== "conflicted") {
      return fail("registry", `lane is not conflicted: ${laneId} (${lane.status})`);
    }
    const branchRef = await this.#liveLaneBranch(lane);
    const retry = await this.#git(["merge", "--no-ff", "--no-edit", branchRef], { cwd: this.#cwd });
    if (retry.code !== 0) {
      await this.#git(["merge", "--abort"], { cwd: this.#cwd });
      return fail("conflict", retry.stderr.trim());
    }
    return { ok: true, value: this.#store.setStatus(laneId, "landed") };
  }
}

/** A recorded integration conflict: resumable lane state, not a crash. */
export interface LaneConflict {
  laneId: string;
  operation: "integrate" | "rebase";
  targetRef: string;
  targetRevision: string;
  laneRevision: string;
}

/** Read-only verdict on the checkout's own dependency install (ADR-0060
 * amendment 5): drifted when `node_modules` is a symlink or a workspace
 * link under it resolves outside the checkout. */
export interface LaneInstallDrift {
  checkoutPath: string;
  drifted: boolean;
  /** `node_modules` itself is a symlink — the removed sharing shape. */
  symlinked: boolean;
  /** Workspace links escaping the checkout, as `name → target`. */
  foreign: string[];
}

/** What the repair door found, and (when applied) did. `command` is the
 * install the checkout declares, or null when it declares none. */
export interface LaneInstallRepair extends LaneInstallDrift {
  command: string | null;
  applied: boolean;
}

/** Lane worktree root for a project: `<home>/.moh/projects/<slug>/lanes/`
 * (ADR-0060 amendment 4). Worktrees live under the user's moh home, next
 * to the project's session store and lane registry — never inside or
 * beside the checkout, which needed write access outside the project and
 * made `.moh-lanes` a positional contract on disk. The slug is resolved
 * with the same identity resolution the session store uses (declared
 * identity > git origin > legacy path hash), so a worktree path always
 * maps back to exactly one project. */
export function laneWorktreeRootFor(cwd: string, home = homedir()): string {
  return join(projectSessionsDir(cwd, home), "lanes");
}

/** Worktree directory for a lane, relative to the project's lane root:
 * the sanitized branch names one directory per branch, per project. */
export function laneWorktreeDirName(branchRef: string): string {
  const safe = branchRef.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "lane";
}

/** A path inside a lane worktree maps to the main checkout that owns it.
 * The anchor is the worktree's `.git` file (git writes a `gitdir:` pointer
 * into worktrees, never into ordinary checkouts): walking up from the cwd,
 * the first directory whose `.git` is a *file* is a lane worktree, and the
 * pointer names the main checkout's git dir. Null when the cwd is not
 * inside a lane worktree (plain checkouts have a `.git` directory, the
 * filesystem root ends the walk). */
export function mainCheckoutFor(cwd: string): string | null {
  let current = resolve(cwd);
  for (;;) {
    const anchor = join(current, ".git");
    try {
      if (existsSync(anchor) && !statSync(anchor).isDirectory()) {
        const pointer = readFileSync(anchor, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/.exec(pointer);
        // The main checkout is the parent of the pointed-to git dir's
        // worktrees entry (`<checkout>/.git/worktrees/<name>`); a pointer
        // outside that shape teaches nothing.
        const worktrees = match ? match[1]!.split(sep) : null;
        const wi = worktrees ? worktrees.lastIndexOf("worktrees") : -1;
        if (worktrees && wi > 0) return worktrees.slice(0, wi - 1).join(sep) || sep;
        return null;
      }
    } catch {
      // Unreadable anchor: keep walking.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Resolves a lane worktree path to an absolute path under the project's
 * lane root in the user's moh home. */
export function resolveWorktreePath(cwd: string, branchRef: string, home = homedir()): string {
  if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
  return resolve(laneWorktreeRootFor(cwd, home), laneWorktreeDirName(branchRef));
}

/**
 * The `lanes.setup` user-config key (ADR-0060 amendment 5): a command a
 * lane runs to install its dependencies, or `false` for a project that has
 * nothing to install. Read where `lanes.auto` is read — the client owns
 * the config file, the service takes the resolved value; this is the one
 * place the key's shape is parsed, so no client invents a second rule.
 * Anything else (a non-string, an empty string) is ignored: the project's
 * own declaration takes over. A missing or unreadable config is unset.
 */
export function readLaneSetup(home?: string): string | false | undefined {
  try {
    const config = readUserConfigFile(userConfigFile(home)) as { lanes?: { setup?: unknown } };
    const value = config.lanes?.setup;
    if (value === false) return false;
    if (typeof value === "string" && value.trim()) return value.trim();
    return undefined;
  } catch {
    return undefined;
  }
}

export interface CleanupCandidate {
  lane: DevelopmentLane;
  ageDays: number;
  dirty: boolean;
}

export interface CleanupReport {
  /** Lanes removed (worktree + branch + registry). */
  removed: DevelopmentLane[];
  /** Lanes that looked stale but hold uncommitted work — reported, never touched. */
  kept: CleanupCandidate[];
}

export interface CleanupOptions {
  /** Minimum age (days since the lane's last update) to consider. Default 7. */
  minAgeDays?: number;
  /** Execute the removals; false = report only (dry run). Default true. */
  apply?: boolean;
}
