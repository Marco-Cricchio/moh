/**
 * `moh lanes` (ADR-0060): the parallel-development CLI surface — a thin
 * projection over the core's `DevelopmentLaneService`. Every write the
 * command performs (feature group, lane, integrate, resolve, abandon) is
 * a core operation; this module formats input, prints results, and maps
 * operation errors to exit codes. No lane state lives here.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  DevelopmentLaneService,
  type LaneOperationError,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const LANES_USAGE = `usage: moh lanes group <name> [--target <ref>] [--cwd <dir>]
       moh lanes start <group> <branch> [--base <ref>] [--session <id>] [--cwd <dir>]
       moh lanes list [--group <name>] [--cwd <dir>]
       moh lanes show <lane-id> [--cwd <dir>]
       moh lanes integrate <lane-id> [--cwd <dir>]
       moh lanes resolve <lane-id> [--cwd <dir>]
       moh lanes status <lane-id> <active|paused|ready|conflicted|abandoned> [--cwd <dir>]
       moh lanes abandon <lane-id> [--cwd <dir>]
       moh lanes remove <lane-id> [--force] [--cwd <dir>]
       moh lanes cleanup [--min-age-days <n>] [--apply] [--cwd <dir>]

Parallel development lanes (feature groups + isolated worktrees): each
lane owns one worktree and one ordinary git branch, so concurrent sessions
never share uncommitted state. Metadata lives in
~/.moh/projects/<slug>/development-lanes.json — never in the repository.

  group <name>              create (or return) a feature group; --target
                            is the integration branch (default: develop)
  start <group> <branch>    create a lane: branch + worktree from the base
                            ref's exact revision. --base defaults to the
                            group's target. The session id binds the lane
                            to one session; a duplicate active worktree or
                            session is refused.
  list [--group]            lanes (and groups) with status, branch, base
                            freshness and worktree health
  show <lane-id>            one lane's full record
  integrate <lane-id>       merge the lane branch into the group's target.
                            On conflict the target merge is aborted and the
                            lane enters a resumable \`conflicted\` state.
  resolve <lane-id>         retry the integration of a conflicted lane
  status <lane-id> <state>  transition the lane's lifecycle status
  abandon <lane-id>         remove the worktree, delete the branch, mark
                            the lane abandoned (release: the worktree path
                            can be reused by a new lane)
  cleanup [--apply]         stale-lane cleanup: lanes idle for at least
                            --min-age-days (default 7) whose worktree has
                            NO uncommitted changes are removed (worktree +
                            branch + registry row). Dirty lanes are
                            reported but never touched. Without --apply it
                            is a dry run.

  --cwd     project root the lanes belong to (default: process.cwd())`;

function printError(err: { write(s: string): void }, context: string, error: LaneOperationError): number {
  const hint =
    error.kind === "conflict"
      ? " (resolve the conflict markers, then: moh lanes resolve)"
      : error.kind === "not-a-repo"
        ? " (run inside the project checkout)"
        : "";
  err.write(`moh lanes ${context}: ${error.kind}: ${error.message}${hint}\n`);
  return 2;
}

function statusLabel(status: string): string {
  return status.padEnd(10);
}

export async function lanesCommand({
  argv,
  home,
  err,
}: {
  argv: string[];
  home?: string;
  err: { write(s: string): void };
}): Promise<number> {
  const out = process.stdout;
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    err.write(LANES_USAGE + "\n");
    return sub ? 0 : 2;
  }
  if (!["group", "start", "list", "show", "integrate", "resolve", "status", "abandon", "cleanup"].includes(sub)) {
    err.write(`moh lanes: unknown command "${sub}"\n\n${LANES_USAGE}\n`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs(rest, { strings: ["cwd", "target", "base", "session", "group", "min-age-days"], booleans: ["apply"] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh lanes ${sub}: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const positional = parsed.positionals;
  const cwd = parsed.strings["cwd"] ? resolve(parsed.strings["cwd"]) : process.cwd();
  const service = new DevelopmentLaneService({ cwd, home: home ?? homedir() });

  if (sub === "group") {
    if (positional.length < 1) {
      err.write("moh lanes group: <name> is required\n");
      return 2;
    }
    const group = await service.ensureFeatureGroup(positional[0]!, parsed.strings["target"] ?? "develop");
    out.write(`feature group ${group.id}  ${group.name}  → ${group.targetRef}\n`);
    return 0;
  }

  if (sub === "start") {
    if (positional.length < 2) {
      err.write("moh lanes start: <group> <branch> are required\n");
      return 2;
    }
    const groups = service.store.listFeatureGroups();
    const group = groups.find((g) => g.name === positional[0]) ?? groups.find((g) => g.id === positional[0]);
    if (!group) {
      err.write(`moh lanes start: no feature group "${positional[0]}" (create one with: moh lanes group ${positional[0]})\n`);
      return 2;
    }
    const sessionId = parsed.strings["session"] ?? `cli-${Date.now().toString(36)}`;
    const result = await service.createWorktreeLane({
      featureGroupId: group.id,
      sessionId,
      branchRef: positional[1]!,
      baseRef: parsed.strings["base"] ?? group.targetRef,
    });
    if (!result.ok) return printError(err, "start", result.error);
    const lane = result.value;
    out.write(`lane ${lane.id}\n  branch    ${lane.branchRef}\n  worktree  ${lane.worktreePath}\n  base      ${lane.baseRef} @ ${lane.baseRevision.slice(0, 12)}\n  target    ${lane.targetRef}\n  session   ${lane.sessionId}\n`);
    return 0;
  }

  if (sub === "list") {
    const groups = service.store.listFeatureGroups();
    const groupName = parsed.strings["group"];
    const selected = groupName ? groups.filter((g) => g.name === groupName || g.id === groupName) : groups;
    if (groupName && selected.length === 0) {
      err.write(`moh lanes list: no feature group "${groupName}"\n`);
      return 2;
    }
    if (groups.length === 0) {
      out.write("no feature groups yet (start one with: moh lanes group <name>)\n");
      return 0;
    }
    for (const group of selected) {
      out.write(`\n${group.name} (${group.id})  target: ${group.targetRef}\n`);
      const lanes = service.listLanes(group.id);
      if (lanes.length === 0) {
        out.write("  (no lanes)\n");
        continue;
      }
      for (const lane of lanes) {
        const inspect = await service.inspect(lane.id);
        const health = inspect.ok
          ? [
              inspect.value.worktreePresent ? "worktree ok" : "worktree MISSING",
              inspect.value.stale ? `base stale (${lane.baseRef} moved)` : "base fresh",
            ].join(" · ")
          : "state unreadable";
        const parent = lane.parentLaneId ? ` ← ${lane.parentLaneId}` : "";
        const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(lane.updatedAt)) / 86_400_000));
        const label = lane.label ? `  "${lane.label}"` : "";
        out.write(`  ${statusLabel(lane.status)} ${lane.id}${label}\n    branch ${lane.branchRef}${parent} · ${ageDays}d\n    ${health}\n`);
      }
    }
    return 0;
  }

  if (sub === "show") {
    if (positional.length < 1) {
      err.write("moh lanes show: <lane-id> is required\n");
      return 2;
    }
    const lane = service.listLanes().find((l) => l.id === positional[0]);
    if (!lane) {
      err.write(`moh lanes show: no lane "${positional[0]}"\n`);
      return 2;
    }
    const inspect = await service.inspect(lane.id);
    out.write(`lane       ${lane.id}\nstatus     ${lane.status}\nrelation   ${lane.relation}${lane.parentLaneId ? ` (parent ${lane.parentLaneId})` : ""}\nbranch     ${lane.branchRef}\nworktree   ${lane.worktreePath}${inspect.ok && !inspect.value.worktreePresent ? "  (MISSING)" : ""}\nbase       ${lane.baseRef} @ ${lane.baseRevision.slice(0, 12)}${inspect.ok && inspect.value.stale ? `  (STALE — ${lane.baseRef} now at ${inspect.value.currentBaseRevision?.slice(0, 12) ?? "?"})` : ""}\ntarget     ${lane.targetRef}\nsession    ${lane.sessionId}\ncreated    ${lane.createdAt}\n`);
    return 0;
  }

  if (sub === "cleanup") {
    const minAgeDays = parsed.strings["min-age-days"] ? Number(parsed.strings["min-age-days"]) : 7;
    if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
      err.write("moh lanes cleanup: --min-age-days must be a non-negative number\n");
      return 2;
    }
    const apply = parsed.booleans["apply"] === true;
    const result = await service.cleanup({ minAgeDays, apply });
    if (!result.ok) return printError(err, "cleanup", result.error);
    const { removed, kept } = result.value;
    if (removed.length === 0 && kept.length === 0) {
      out.write("no stale lanes — nothing to clean up\n");
      return 0;
    }
    for (const lane of removed) {
      out.write(`${apply ? "removed" : "would remove"}: ${lane.id}${lane.label ? ` (${lane.label})` : ""} · ${lane.branchRef}\n`);
    }
    for (const candidate of kept) {
      out.write(`kept (uncommitted work): ${candidate.lane.id}${candidate.lane.label ? ` (${candidate.lane.label})` : ""} · ${candidate.lane.branchRef} · ${candidate.ageDays}d old\n`);
    }
    if (!apply && removed.length > 0) {
      out.write(`\ndry run — re-run with --apply to remove ${removed.length} lane(s)\n`);
    }
    return 0;
  }

  if (sub === "integrate") {
    if (positional.length < 1) {
      err.write("moh lanes integrate: <lane-id> is required\n");
      return 2;
    }
    const result = await service.integrate(positional[0]!);
    if (!result.ok) return printError(err, "integrate", result.error);
    if (result.value.outcome === "landed") {
      out.write(`landed: ${result.value.lane.branchRef} → ${result.value.lane.targetRef}\n`);
    } else {
      const c = result.value.conflict;
      out.write(`conflict: ${c.laneId} · ${c.operation} · target ${c.targetRef} @ ${c.targetRevision.slice(0, 12)} vs lane @ ${c.laneRevision.slice(0, 12)}\n`);
      out.write(`the target checkout is clean — resolve the conflict in the lane's worktree, then: moh lanes resolve ${c.laneId}\n`);
    }
    return 0;
  }

  if (sub === "resolve") {
    if (positional.length < 1) {
      err.write("moh lanes resolve: <lane-id> is required\n");
      return 2;
    }
    const result = await service.resolve(positional[0]!);
    if (!result.ok) return printError(err, "resolve", result.error);
    out.write(`landed: ${result.value.branchRef} → ${result.value.targetRef}\n`);
    return 0;
  }

  if (sub === "status") {
    if (positional.length < 2) {
      err.write("moh lanes status: <lane-id> <state> are required\n");
      return 2;
    }
    const state = positional[1]!;
    if (!["active", "paused", "ready", "conflicted", "abandoned"].includes(state)) {
      err.write(`moh lanes status: invalid state "${state}" (active|paused|ready|conflicted|abandoned)\n`);
      return 2;
    }
    const result = await service.setStatus(positional[0]!, state as never);
    if (!result.ok) return printError(err, "status", result.error);
    out.write(`status: ${result.value.id} → ${result.value.status}\n`);
    return 0;
  }

  // abandon
  if (positional.length < 1) {
    err.write("moh lanes abandon: <lane-id> is required\n");
    return 2;
  }
  const result = await service.abandon(positional[0]!);
  if (!result.ok) return printError(err, "abandon", result.error);
  out.write(`abandoned: ${result.value.id} (branch ${result.value.branchRef} deleted, worktree removed)\n`);
  return 0;
}

/** Registry-only removal of one lane row (no git effects). */
export async function lanesRemoveCommand({
  argv,
  home,
  err,
}: {
  argv: string[];
  home?: string;
  err: { write(s: string): void };
}): Promise<number> {
  const out = process.stdout;
  let parsed;
  try {
    parsed = parseArgs(argv, { strings: ["cwd"], booleans: ["force"] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh lanes remove: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const positional = parsed.positionals;
  if (positional.length < 1) {
    err.write("moh lanes remove: <lane-id> is required\n");
    return 2;
  }
  const cwd = parsed.strings["cwd"] ? resolve(parsed.strings["cwd"]) : process.cwd();
  const service = new DevelopmentLaneService({ cwd, home: home ?? homedir() });
  const result = await service.remove(positional[0]!, { force: parsed.booleans["force"] });
  if (!result.ok) return printError(err, "remove", result.error);
  out.write(`removed: ${result.value.id} (registry row dropped; git state untouched)\n`);
  return 0;
}
