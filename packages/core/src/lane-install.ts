/**
 * Lane dependency install (ADR-0060 amendment 5): a lane owns its own
 * `node_modules`, and the install command belongs to the project.
 *
 * The pieces are deliberately separate — detection is pure over the lane's
 * own files, ownership is a filesystem predicate, running is injectable —
 * so the service can decide *when* to pay the install cost without this
 * module knowing anything about lanes.
 *
 * The old sharing mechanism (symlinking the checkout's `node_modules` into
 * a worktree) is gone: bun writes the `@moh/*` workspace links relative to
 * the physical install directory, so one `bun install` inside one lane
 * silently repointed the checkout and every other lane at that lane.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * What a lane's dependency install did, as recorded in the registry row
 * (never a marker file inside the worktree — the #1223 accident class).
 * `nothing` with a reason is reported once by the provisioning result;
 * without one it is silent (a user-level store, or no manifest at all).
 */
export type LaneInstallOutcome =
  | { kind: "installed"; command: string; fingerprint: string; at: string }
  | { kind: "nothing"; at: string; reason?: string }
  | { kind: "failed"; command: string; reason: string; at: string };

/** Detection over a directory's own files. */
export type LaneSetupDetection =
  | { kind: "install"; command: string; fingerprint: string }
  | { kind: "nothing"; reason?: string };

/** Injectable installer (tests pass a fake); default spawns a shell. */
export type LaneInstallRunner = (input: { command: string; cwd: string }) => Promise<{ ok: boolean; output: string }>;

/** Default installer: the command in the lane's own worktree, through a
 * shell (the command may be a user-declared `lanes.setup` line). */
export const defaultLaneInstallRunner: LaneInstallRunner = async ({ command, cwd }) => {
  const argv = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
  try {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, output: (code === 0 ? stdout : `${stdout}\n${stderr}`).trim() };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
};

/** `packageManager` name → its install command. Only managers moh can run
 * without inventing flags; anything else falls through to the lockfiles. */
const PACKAGE_MANAGERS: Record<string, string> = {
  bun: "bun install",
  npm: "npm install",
  yarn: "yarn install",
  pnpm: "pnpm install",
};

/** Lockfile → command, for ecosystems whose dependency store lives in the
 * project directory: a lane-scoped install. First match wins. */
const PROJECT_STORES: ReadonlyArray<{ lockfiles: readonly string[]; command: string }> = [
  { lockfiles: ["bun.lock", "bun.lockb"], command: "bun install" },
  { lockfiles: ["package-lock.json"], command: "npm install" },
  { lockfiles: ["yarn.lock"], command: "yarn install" },
  { lockfiles: ["pnpm-lock.yaml"], command: "pnpm install" },
  { lockfiles: ["uv.lock"], command: "uv sync" },
  { lockfiles: ["composer.lock"], command: "composer install" },
  { lockfiles: ["mix.lock"], command: "mix deps.get" },
  { lockfiles: ["poetry.lock"], command: "poetry install" },
  { lockfiles: ["Gemfile.lock"], command: "bundle install" },
];

/** A user-level store: dependencies live outside the project, so there is
 * nothing lane-scoped to run and nothing to report. */
const USER_STORES: readonly string[] = [
  "Cargo.lock",
  "go.sum",
  "packages.lock.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

/** A manifest with no recognized install: the lane exists without its own
 * dependencies and the reason is visible once. */
const MANIFESTS: readonly string[] = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "setup.py",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "pubspec.yaml",
  "Cargo.toml",
  "go.mod",
  "deno.json",
  "build.sbt",
];

/** Roots of the installs a lane may have created. Bun keeps every
 * workspace's `node_modules` in one place *outside* the install it is
 * entered from, which is an entirely correct layout — the ownership check
 * must not mistake it for the removed sharing. */
const DISCOVERED_STORE_ROOTS: readonly string[] = ["node_modules/.bun", "node_modules/.pnpm", "node_modules/.yarn"];

/** The project's declared dependency fingerprint: the lockfile the install
 * was made from, or the manifest that named the manager. */
function fingerprintOf(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

function readPackageManager(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { packageManager?: unknown };
    const value = parsed?.packageManager;
    if (typeof value !== "string" || !value.trim()) return undefined;
    return value.split("@")[0]!.trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolves the install a directory declares, from its own files: the
 * `lanes.setup` config last word, then `packageManager`, then the lockfile
 * table. moh never invents a command — an unrecognized project with a
 * manifest present is a visible nothing, and no manifest is silent.
 */
export function detectLaneSetup(worktreePath: string, setup?: string | false): LaneSetupDetection {
  if (setup === false) return { kind: "nothing" };
  if (typeof setup === "string" && setup.trim()) return { kind: "install", command: setup.trim(), fingerprint: "" };
  const manager = readPackageManager(worktreePath);
  if (manager && PACKAGE_MANAGERS[manager]) {
    return { kind: "install", command: PACKAGE_MANAGERS[manager], fingerprint: fingerprintOf(join(worktreePath, "package.json")) };
  }
  for (const entry of PROJECT_STORES) {
    const found = entry.lockfiles.find((lockfile) => existsSync(join(worktreePath, lockfile)));
    if (found) return { kind: "install", command: entry.command, fingerprint: fingerprintOf(join(worktreePath, found)) };
  }
  if (USER_STORES.some((lockfile) => existsSync(join(worktreePath, lockfile)))) return { kind: "nothing" };
  if (MANIFESTS.some((manifest) => existsSync(join(worktreePath, manifest)))) {
    return { kind: "nothing", reason: "no recognized install command — set lanes.setup in ~/.moh/config" };
  }
  return { kind: "nothing" };
}

/**
 * Workspace links under `root/node_modules` whose target escapes `root`
 * without landing in a discovered store the worktree itself owns (bun and
 * pnpm hoist every workspace there; the lane's own links land in its own).
 * The sharing bug left `@moh/*` pointing at another lane; a lane's own
 * install keeps every link inside its own tree.
 */
export function foreignWorkspaceLinks(root: string): string[] {
  const scope = join(root, "node_modules", "@moh");
  let entries: string[];
  try {
    entries = readdirSync(scope);
  } catch {
    return [];
  }
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    base = root;
  }
  const discovered = DISCOVERED_STORE_ROOTS.map((store) => join(base, store));
  const foreign: string[] = [];
  for (const entry of entries) {
    try {
      const target = realpathSync(join(scope, entry));
      const inside = target === base || target.startsWith(base + sep);
      const hoisted = discovered.some((store) => target === store || target.startsWith(store + sep));
      if (!inside && !hoisted) foreign.push(`${entry} → ${target}`);
    } catch {
      // A dangling link resolves nowhere: not the lane's own store either.
      foreign.push(`${entry} → ?`);
    }
  }
  return foreign;
}

/** True when the store is not the worktree's own and must go before an
 * install: a symlinked `node_modules` (the removed sharing) or a workspace
 * link resolving outside the worktree, other than one pointing into the
 * worktree's own discovered store (`node_modules/.bun/…`, where bun keeps
 * every workspace's link). */
export function foreignStore(root: string): boolean {
  const store = join(root, "node_modules");
  try {
    if (lstatSync(store).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  return foreignWorkspaceLinks(root).length > 0;
}

/** Discards a `node_modules` the worktree does not own, so the install
 * that follows writes inside the worktree and never through the link
 * (ADR-0060 amendment 5: a lane resolves its own packages, or none). */
export function removeForeignStore(root: string): void {
  if (!foreignStore(root)) return;
  rmSync(join(root, "node_modules"), { recursive: true, force: true });
}

/**
 * True when `root` owns its `node_modules`: a real directory inside the
 * worktree, with no workspace link escaping it. A symlink (the removed
 * sharing), a missing store, or a foreign link is not owned — the runtime
 * check refuses to use one instead of trusting it.
 */
export function laneOwnsInstall(root: string): boolean {
  try {
    if (!lstatSync(join(root, "node_modules")).isDirectory()) return false;
  } catch {
    return false;
  }
  return !foreignStore(root);
}

/** Whether two outcomes state the same fact. An `installed` compares its
 * command and a `nothing` its reason — the fields the row shows — so a
 * genuinely different outcome is never mistaken for the recorded one. */
export function sameInstallOutcome(a: LaneInstallOutcome | undefined, b: LaneInstallOutcome): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "installed" && b.kind === "installed") return a.command === b.command;
  if (a.kind === "nothing" && b.kind === "nothing") return (a.reason ?? "") === (b.reason ?? "");
  if (a.kind === "failed" && b.kind === "failed") return a.command === b.command && a.reason === b.reason;
  return true;
}

/**
 * One sentence stating an install outcome, or null when there is nothing
 * to state (no record, or a silent nothing). Every lane surface renders
 * this same line — `moh lanes list`/`show`, the TUI `/lanes` detail row
 * and the provisioning notice — so a lane's install reads identically
 * wherever it is stated.
 */
export function laneInstallLine(outcome: LaneInstallOutcome | undefined): string | null {
  if (!outcome) return null;
  if (outcome.kind === "installed") return `install ${outcome.command}`;
  if (outcome.kind === "failed") return `install FAILED (${outcome.command}): ${outcome.reason} — retried on the next open`;
  return outcome.reason ? `install nothing (${outcome.reason})` : null;
}

/** Runs the detected install in the worktree and normalizes the outcome.
 * A project that declares nothing to install produces a `nothing` outcome
 * without spawning anything. */
export async function installLaneDependencies(options: {
  worktreePath: string;
  setup?: string | false;
  runner?: LaneInstallRunner;
}): Promise<LaneInstallOutcome> {
  const detection = detectLaneSetup(options.worktreePath, options.setup);
  const at = new Date().toISOString();
  if (detection.kind === "nothing") {
    return detection.reason ? { kind: "nothing", at, reason: detection.reason } : { kind: "nothing", at };
  }
  const run = await (options.runner ?? defaultLaneInstallRunner)({ command: detection.command, cwd: options.worktreePath });
  if (!run.ok) {
    const first = run.output.split("\n").find((line) => line.trim())?.trim() ?? "install failed";
    return { kind: "failed", command: detection.command, reason: first.slice(0, 200), at };
  }
  return { kind: "installed", command: detection.command, fingerprint: detection.fingerprint, at };
}
