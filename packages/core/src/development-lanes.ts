import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { projectSessionsDir } from "./session-store";

export type LaneRelation = "independent" | "depends-on" | "integration";
export type LaneStatus = "active" | "paused" | "ready" | "integrating" | "conflicted" | "landed" | "abandoned";

export interface FeatureGroup {
  id: string;
  name: string;
  targetRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface DevelopmentLane {
  id: string;
  featureGroupId: string;
  sessionId: string;
  worktreePath: string;
  branchRef: string;
  baseRef: string;
  baseRevision: string;
  targetRef: string;
  relation: LaneRelation;
  parentLaneId?: string;
  status: LaneStatus;
  /** What this lane is working on (issue id, task slug) — captured from
   * the session's first user message or set explicitly. User-facing in
   * `moh lanes list` and /lanes so a stale lane is identifiable. */
  label?: string;
  createdAt: string;
  updatedAt: string;
}

interface LaneState {
  version: 1;
  featureGroups: FeatureGroup[];
  lanes: DevelopmentLane[];
}

export interface CreateFeatureGroupInput {
  name: string;
  targetRef: string;
}

export interface CreateLaneInput {
  featureGroupId: string;
  sessionId: string;
  worktreePath: string;
  branchRef: string;
  baseRef: string;
  baseRevision: string;
  targetRef: string;
  relation: LaneRelation;
  parentLaneId?: string;
}

export interface LaneStoreOptions {
  /** The project root whose user-owned lane state is being managed. */
  cwd: string;
  /** Injectable home for tests and alternate clients. */
  home?: string;
}

const STATE_FILE = "development-lanes.json";

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must not be empty`);
}

function readState(file: string): LaneState {
  if (!existsSync(file)) return { version: 1, featureGroups: [], lanes: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read development lane state: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
    throw new Error("unsupported development lane state version");
  }
  const state = parsed as LaneState;
  if (!Array.isArray(state.featureGroups) || !Array.isArray(state.lanes)) {
    throw new Error("invalid development lane state");
  }
  return state;
}

function writeState(file: string, state: LaneState): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** User-owned persistent state for feature groups and isolated development lanes. */
export class DevelopmentLaneStore {
  readonly #file: string;

  constructor(options: LaneStoreOptions) {
    this.#file = join(projectSessionsDir(options.cwd, options.home ?? homedir()), STATE_FILE);
  }

  get file(): string {
    return this.#file;
  }

  listFeatureGroups(): FeatureGroup[] {
    return readState(this.#file).featureGroups.map((group) => ({ ...group }));
  }

  listLanes(featureGroupId?: string): DevelopmentLane[] {
    const lanes = readState(this.#file).lanes;
    return lanes
      .filter((lane) => featureGroupId === undefined || lane.featureGroupId === featureGroupId)
      .map((lane) => ({ ...lane }));
  }

  createFeatureGroup(input: CreateFeatureGroupInput): FeatureGroup {
    assertNonEmpty(input.name, "feature group name");
    assertNonEmpty(input.targetRef, "feature group targetRef");
    const state = readState(this.#file);
    const name = input.name.trim();
    if (state.featureGroups.some((group) => group.name === name)) {
      throw new Error(`feature group already exists: ${name}`);
    }
    const timestamp = now();
    const group: FeatureGroup = {
      id: id("feature"),
      name,
      targetRef: input.targetRef.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.featureGroups.push(group);
    writeState(this.#file, state);
    return { ...group };
  }

  /**
   * Validates a lane creation without writing state: the service probes
   * before any Git write so a refused input never leaves partial effects.
   * Resolves the group's target ref for the caller.
   */
  probeLane(input: CreateLaneInput): { ok: true; value: { targetRef: string } } | { ok: false; error: { kind: "registry"; message: string } } {
    try {
      this.#assertCreateLane(input);
      const state = readState(this.#file);
      const group = state.featureGroups.find((candidate) => candidate.id === input.featureGroupId);
      if (!group) return { ok: false, error: { kind: "registry", message: `unknown feature group: ${input.featureGroupId}` } };
      if (state.lanes.some((lane) => lane.worktreePath === input.worktreePath && !["landed", "abandoned"].includes(lane.status))) {
        return { ok: false, error: { kind: "registry", message: `worktree is already assigned to an active lane: ${input.worktreePath}` } };
      }
      if (state.lanes.some((lane) => lane.sessionId === input.sessionId && !["landed", "abandoned"].includes(lane.status))) {
        return { ok: false, error: { kind: "registry", message: `session is already assigned to an active lane: ${input.sessionId}` } };
      }
      return { ok: true, value: { targetRef: group.targetRef } };
    } catch (error) {
      return { ok: false, error: { kind: "registry", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  #assertCreateLane(input: CreateLaneInput): void {
    assertNonEmpty(input.featureGroupId, "featureGroupId");
    assertNonEmpty(input.sessionId, "sessionId");
    assertNonEmpty(input.worktreePath, "worktreePath");
    assertNonEmpty(input.branchRef, "branchRef");
    assertNonEmpty(input.baseRef, "baseRef");
    assertNonEmpty(input.baseRevision, "baseRevision");
    assertNonEmpty(input.targetRef, "targetRef");
    const state = readState(this.#file);
    const group = state.featureGroups.find((candidate) => candidate.id === input.featureGroupId);
    if (!group) throw new Error(`unknown feature group: ${input.featureGroupId}`);
    if (input.relation === "depends-on" && !input.parentLaneId) {
      throw new Error("dependent lane requires parentLaneId");
    }
    if (input.relation !== "depends-on" && input.parentLaneId !== undefined) {
      throw new Error("parentLaneId is only valid for a dependent lane");
    }
    if (input.parentLaneId) {
      const parent = state.lanes.find((lane) => lane.id === input.parentLaneId);
      if (!parent) throw new Error(`unknown parent lane: ${input.parentLaneId}`);
      if (parent.featureGroupId !== input.featureGroupId) throw new Error("parent lane must belong to the same feature group");
    }
  }

  /** Validates and registers a lane, returning the stored record. */
  createLane(input: CreateLaneInput): DevelopmentLane {
    this.#assertCreateLane(input);
    const state = readState(this.#file);
    const group = state.featureGroups.find((candidate) => candidate.id === input.featureGroupId)!;
    if (state.lanes.some((lane) => lane.worktreePath === input.worktreePath && !["landed", "abandoned"].includes(lane.status))) {
      throw new Error(`worktree is already assigned to an active lane: ${input.worktreePath}`);
    }
    if (state.lanes.some((lane) => lane.sessionId === input.sessionId && !["landed", "abandoned"].includes(lane.status))) {
      throw new Error(`session is already assigned to an active lane: ${input.sessionId}`);
    }
    const timestamp = now();
    const lane: DevelopmentLane = {
      id: id("lane"),
      featureGroupId: input.featureGroupId,
      sessionId: input.sessionId,
      worktreePath: input.worktreePath,
      branchRef: input.branchRef,
      baseRef: input.baseRef,
      baseRevision: input.baseRevision,
      targetRef: input.targetRef,
      relation: input.relation,
      ...(input.parentLaneId ? { parentLaneId: input.parentLaneId } : {}),
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.lanes.push(lane);
    group.updatedAt = timestamp;
    writeState(this.#file, state);
    return { ...lane };
  }

  setStatus(laneId: string, status: LaneStatus): DevelopmentLane {
    const state = readState(this.#file);
    const lane = state.lanes.find((candidate) => candidate.id === laneId);
    if (!lane) throw new Error(`unknown lane: ${laneId}`);
    lane.status = status;
    lane.updatedAt = now();
    writeState(this.#file, state);
    return { ...lane };
  }

  /** Deletes a single lane's registry row. Registry-only: never touches
   * the worktree or the branch — the service gates the destructive path.
   * Returns the removed record; throws on an unknown id. */
  removeLane(laneId: string): DevelopmentLane {
    const state = readState(this.#file);
    const index = state.lanes.findIndex((candidate) => candidate.id === laneId);
    if (index === -1) throw new Error(`unknown lane: ${laneId}`);
    const [removed] = state.lanes.splice(index, 1);
    const group = state.featureGroups.find((candidate) => candidate.id === removed!.featureGroupId);
    if (group) group.updatedAt = now();
    writeState(this.#file, state);
    return { ...removed! };
  }

  /** Sets (or clears, with a blank value) a lane's user-facing label. */
  setLabel(laneId: string, label: string): DevelopmentLane {
    const state = readState(this.#file);
    const lane = state.lanes.find((candidate) => candidate.id === laneId);
    if (!lane) throw new Error(`unknown lane: ${laneId}`);
    const clean = label.trim();
    if (clean) lane.label = clean.slice(0, 120);
    else delete lane.label;
    lane.updatedAt = now();
    writeState(this.#file, state);
    return { ...lane };
  }
}
