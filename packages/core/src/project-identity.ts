import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { anyOpenSessionInDir, isSessionFile, projectTrashDir } from "./session-store";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as pathResolve, sep } from "node:path";

/** The pre-#398 path-derived location, retained only to find old data. */
export function legacyProjectSlug(cwd: string): string {
  const resolved = pathResolve(cwd);
  const base = basename(resolved).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function identityFile(cwd: string): string {
  return join(pathResolve(cwd), ".moh", "project.json");
}

/** Public for SessionStore.listSpawnFree (#595): the identity file path. */
export function identityFileFor(cwd: string): string {
  return identityFile(cwd);
}

function declaredId(file: string): string | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
export { declaredId };

function createIdentity(file: string): string | null {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    const id = randomUUID();
    // Write privately before publishing it. link() is an O_EXCL-equivalent
    // atomic publish: readers never observe a partially-written identity.
    writeFileSync(tmp, `${JSON.stringify({ id })}\n`, { mode: 0o644 });
    try {
      linkSync(tmp, file);
      return id;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") return null;
      return declaredId(file);
    }
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file was never created or was already cleaned up.
    }
  }
}

function identitySlug(id: string): string {
  return `project-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}
export { identitySlug };

/**
 * Canonical origin remote identity: `host/owner/repo`, lowercased, with the
 * protocol, credentials, port-less host, and trailing `.git` normalized away
 * (#591). Returns null when there is no origin or it cannot be parsed.
 */
export function canonicalRemoteSlug(cwd: string): string | null {
  // NOTE: deliberately NOT memoized (#595 flake investigation, #939): a
  // process-lifetime cache would leak stale slugs for temp dirs that
  // appear/disappear under a repo (git searches upward). Safety does not
  // need one: this spawn is synchronous and runs the event loop inside the
  // call under bun (ADR-0024), so callers that run inside a React window
  // resolve through `prepareProjectIdentity` at their boot instead
  // (`preparedIdentities` below); the TUI entry point warms before the
  // first frame only to spare the first paint a `git` spawn.
  return canonicalRemoteSlugUncached(cwd);
}

function canonicalRemoteSlugUncached(cwd: string): string | null {
  let url: string;
  try {
    url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
  return remoteSlugFromUrl(url);
}

/**
 * Async twin of `canonicalRemoteSlugUncached` for the boot path (#939): a
 * promise continuation is not a React execution window, so the spawn can
 * never re-enter the reconciler whatever is pending. Same question, same
 * normalization, same answer.
 */
async function canonicalRemoteSlugAsync(cwd: string): Promise<string | null> {
  let stdout: string;
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    stdout = out;
  } catch {
    return null;
  }
  return remoteSlugFromUrl(stdout.trim());
}

function remoteSlugFromUrl(url: string): string | null {
  if (!url) return null;
  // scp-like spelling: git@host:owner/repo(.git)
  let rest = /^git@([^:/]+):(.+)$/.exec(url)?.slice(1) as [string, string] | undefined;
  if (rest) {
    return normalizeRemoteHostRepo(rest[0], rest[1]);
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ssh:" || parsed.protocol === "https:" || parsed.protocol === "http:") {
      const host = parsed.hostname;
      if (host && /^[\w.-]+(\/[\w.-]+)+$/.test(parsed.pathname.slice(1))) {
        return normalizeRemoteHostRepo(host, parsed.pathname.slice(1));
      }
    }
  } catch {
    // Not a URL; fall through to null.
  }
  return null;
}

function normalizeRemoteHostRepo(host: string, repoPath: string): string | null {
  // The full repository path is kept, so GitLab-style nested groups
  // (`host/group/sub/repo`) resolve to their own slug; it becomes a nested
  // directory under `~/.moh/projects/`, which the directory builders create
  // recursively. Trailing `.git` is stripped; case is normalized away.
  const repo = repoPath.replace(/\.git$/i, "").toLowerCase();
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) return null;
  // `.`/`..` segments pass the shape check but would let a crafted origin
  // move data outside ~/.moh/projects/ once joined; reject them.
  if (repo.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return `${host.toLowerCase()}/${repo}`;
}

/**
 * In-process pin: the first slug resolution for a project wins for the
 * process lifetime, so a mid-session slug re-evaluation can never split a
 * project's data across two directories (#591).
 */
const pinnedSlugs = new Map<string, { slug: string; legacySlug: string; declared: boolean }>();

/**
 * Identities resolved *before* a React render ever asked for them (#939):
 * `prepareProjectIdentity` fills this, and `resolveProjectIdentity` honours
 * it unconditionally (no `anyOpenSessionInDir` release like the #591 pin
 * above — the point is that no later React-phase call spawns, and a boot
 * resolution is the client's own declared starting identity).
 */
const preparedIdentities = new Map<string, { slug: string; legacySlug: string; declared: boolean }>();

function identityKey(cwd: string, home: string): string {
  return `${pathResolve(cwd)}\u0000${pathResolve(home)}`;
}

/**
 * Whether this project's identity was already resolved by a boot call, so
 * every later resolution is served from memory and spawns nothing (#939).
 */
export function isProjectIdentityPrepared(cwd: string, home: string): boolean {
  return preparedIdentities.has(identityKey(cwd, home));
}

/**
 * Resolves the project identity **without touching the event loop's React
 * window** (#939): the git probe is awaited instead of blocking, and the
 * answer — plus the migration work `resolveProjectIdentityUncached` owns —
 * lands in `preparedIdentities`, so a plain `render(<App/>)` can boot
 * without any synchronous spawn reachable from its render phase.
 *
 * `warm: true` answers with the synchronous probe instead. Callers that run
 * *outside* React (the TUI entry point, before the first frame) use it to
 * keep the first frame free of a boot state.
 */
export async function prepareProjectIdentity(cwd: string, home: string, opts: { warm?: boolean } = {}): Promise<{ slug: string; legacySlug: string; declared: boolean }> {
  const key = identityKey(cwd, home);
  const known = preparedIdentities.get(key);
  if (known) return known;
  const legacySlug = legacyProjectSlug(cwd);
  const result = opts.warm
    ? resolveProjectIdentityUncached(cwd, home, legacySlug)
    : resolveProjectIdentityUncached(cwd, home, legacySlug, await canonicalRemoteSlugAsync(cwd));
  preparedIdentities.set(key, result);
  pinnedSlugs.set(key, result);
  return result;
}

/**
 * Synchronous twin of `prepareProjectIdentity` for callers that are not
 * inside a React window (the TUI entry point warms before the first frame).
 */
export function prepareProjectIdentityNow(cwd: string, home: string): { slug: string; legacySlug: string; declared: boolean } {
  const key = identityKey(cwd, home);
  const known = preparedIdentities.get(key);
  if (known) return known;
  const result = resolveProjectIdentityUncached(cwd, home, legacyProjectSlug(cwd));
  preparedIdentities.set(key, result);
  pinnedSlugs.set(key, result);
  return result;
}

/**
 * Resolves the stable project identity and migrates pre-#398 data once.
 * An unreadable identity deliberately leaves the project on its legacy slug.
 * When the project has a git `origin` remote, the slug derives from its
 * canonical `host/owner/repo` form so clones on different machines share one
 * identity (#591); otherwise the uuid-derived identity applies.
 */
export function resolveProjectIdentity(cwd: string, home: string): { slug: string; legacySlug: string; declared: boolean } {
  const legacySlug = legacyProjectSlug(cwd);
  const key = identityKey(cwd, home);
  const prepared = preparedIdentities.get(key);
  if (prepared) return prepared;
  const pinned = pinnedSlugs.get(key);
  if (pinned) {
    // The pin binds only while a session file under the pinned slug is open:
    // re-resolution is deterministic and safe once nothing is open, so a
    // project that gains a git origin later still migrates (#592).
    if (anyOpenSessionInDir(join(home, ".moh", "projects", pinned.slug))) return pinned;
    pinnedSlugs.delete(key);
  }

  const result = resolveProjectIdentityUncached(cwd, home, legacySlug);
  pinnedSlugs.set(key, result);
  return result;
}

function resolveProjectIdentityUncached(cwd: string, home: string, legacySlug: string, remoteOverride?: string | null): { slug: string; legacySlug: string; declared: boolean } {
  const remoteSlug = remoteOverride !== undefined ? remoteOverride : canonicalRemoteSlug(cwd);
  if (remoteSlug) {
    const projects = join(home, ".moh", "projects");
    const dir = join(projects, remoteSlug);
    // A session file of this project is already open in this process: keep
    // its identity (uuid-derived when the session predates #591) so the
    // slug switch never orphans an open session file. The directory is not
    // created eagerly here beyond what the callers already do.
    const file = identityFile(cwd);
    const uuidId = declaredId(file);
    if (uuidId) {
      const uuidDir = join(projects, identitySlug(uuidId));
      if (anyOpenSessionInDir(uuidDir) && !anyOpenSessionInDir(dir)) {
        return { slug: identitySlug(uuidId), legacySlug, declared: true };
      }
    }
    if (!existsSync(dir)) {
      // One-time migration of an existing uuid-derived data directory (#592):
      // a project born without git that later gains `origin` keeps its data.
      // The durable note precedes the atomic rename, so a crash cannot leave
      // a completed migration without its record; a racing opener losing the
      // rename (ENOENT) finds the winner's directory and moves on.
      if (uuidId) {
        const uuidDir = join(projects, identitySlug(uuidId));
        if (uuidDir !== dir && existsSync(uuidDir)) {
          writeFileSync(join(uuidDir, "migration.log"), `Migrated project directory ${identitySlug(uuidId)} to ${remoteSlug}.\n`, { flag: "a", mode: 0o600 });
          try {
            // The remote slug may be a nested path (`host/owner/repo`).
            mkdirSync(join(dir, ".."), { recursive: true, mode: 0o700 });
            renameSync(uuidDir, dir);
          } catch (error) {
            // Another opener may have completed the same one-time rename first.
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || !existsSync(dir)) throw error;
          }
          return { slug: remoteSlug, legacySlug, declared: true };
        }
      }
      // Materialize the project directory (owner-only) so the first session
      // or memory write cannot race with the mode-tightening rules: only
      // newly created directories get 0o700, existing ones are untouched.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      // #1217: the remote directory was materialized by another opener; if
      // it is an empty shell, the uuid contents still migrate in, and when
      // both sides hold data the uuid directory is recorded (never merged
      // silently) so clients can surface both paths.
      migrateStrandedUuidData(projects, remoteSlug, uuidId);
      recordStrandedUuidData(projects, remoteSlug, uuidId);
    }
    return { slug: remoteSlug, legacySlug, declared: true };
  }
  const file = identityFile(cwd);
  const id = declaredId(file) ?? (!existsSync(file) ? createIdentity(file) : null);
  if (!id) return { slug: legacySlug, legacySlug, declared: false };

  const slug = identitySlug(id);
  const projects = join(home, ".moh", "projects");
  const legacyDir = join(projects, legacySlug);
  const declaredDir = join(projects, slug);
  if (legacySlug !== slug && existsSync(legacyDir) && !existsSync(declaredDir)) {
    // The note moves with the directory, so a crash after the atomic rename
    // cannot leave a completed migration without its durable record.
    writeFileSync(join(legacyDir, "migration.log"), `Migrated legacy project directory ${legacySlug} to ${slug}.\n`, { flag: "a", mode: 0o600 });
    try {
      // Both paths share a parent, making rename atomic on the local filesystem.
      renameSync(legacyDir, declaredDir);
    } catch (error) {
      // Another opener may have completed the same one-time rename first.
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || !existsSync(declaredDir)) throw error;
    }
  }
  return { slug, legacySlug, declared: true };
}

/** The name of the durable stranded-data record inside a project directory (#1217). */
export const STRANDED_DATA_FILE = "stranded-data.json";

export interface StrandedDataRecord {
  /** The directory still holding the stranded data (absolute path). */
  source: string;
  /** The remote-slug directory the project now resolves to. */
  destination: string;
  /** ISO timestamp of when the stranded state was first recorded. */
  recordedAt: string;
  /** #1243: durable "keep it and stop warning" acknowledgement; a genuinely
   * new stranded situation (a different source) re-records without it. */
  acknowledgedAt?: string;
}

/**
 * Whether a project directory holds real data (#1217): anything beyond the
 * durable migration note counts — session logs, memory, session notes,
 * handoff, project map. `.DS_Store` is not data either (#1243): a Finder
 * visit must not keep a stranded record alive.
 */
function holdsProjectData(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name !== "migration.log" && name !== ".DS_Store");
  } catch {
    return false;
  }
}

/**
 * #1217: the remote-slug directory was materialized empty by a second moh
 * process before the #592 one-shot rename could fire. Its contents migrate
 * once anyway: the durable note is written first, then every top-level
 * entry moves into the remote directory (a same-named survivor keeps the
 * remote copy and the uuid copy is preserved under a `.migrated-<uuidslug>`
 * sibling name, recorded in the note). Never throws to the caller: a racing
 * opener that loses finds the winner's directory and moves on.
 */
function migrateStrandedUuidData(projects: string, remoteSlug: string, uuidId: string | null): void {
  if (!uuidId) return;
  const dir = join(projects, remoteSlug);
  const uuidDir = join(projects, identitySlug(uuidId));
  if (uuidDir === dir || !existsSync(uuidDir) || !holdsProjectData(uuidDir)) return;
  if (existsSync(dir) && holdsProjectData(dir)) {
    recordStrandedUuidData(projects, remoteSlug, uuidId);
    return;
  }
  const uuidSlug = identitySlug(uuidId);
  writeFileSync(join(uuidDir, "migration.log"), `Migrated project directory ${uuidSlug} to ${remoteSlug} (remote directory was materialized empty; contents moved).\n`, { flag: "a", mode: 0o600 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(uuidDir)) {
    const from = join(uuidDir, name);
    let to = join(dir, name);
    try {
      if (existsSync(to)) {
        to = join(dir, `.${name}.migrated-${uuidSlug}`);
        writeFileSync(join(dir, "migration.log"), `Collision on "${name}": remote copy kept, uuid copy preserved as ${basename(to)}.\n`, { flag: "a", mode: 0o600 });
      }
      renameSync(from, to);
    } catch {
      // A racing opener or an unmovable entry: leave it stranded visibly
      // rather than half-report a move that did not happen.
      writeFileSync(join(dir, "migration.log"), `Could not move "${name}" from ${uuidDir}; it remains there.\n`, { flag: "a", mode: 0o600 });
    }
  }
  try {
    if (!holdsProjectData(uuidDir)) rmSync(uuidDir, { recursive: true });
  } catch {
    // The emptied shell stays; the note in the remote directory explains it.
  }
}

/**
 * #1217: both directories hold data. Nothing is merged or overwritten (the
 * remote-slug directory stays authoritative), but the stranded uuid data is
 * recorded once so clients surface both paths instead of leaving the old
 * session silently invisible. Idempotent for the same source (the first
 * record wins); a genuinely new stranded situation — a different source
 * directory (#1243) — replaces the record, which also clears any
 * acknowledgement so the warning re-arms.
 */
function recordStrandedUuidData(projects: string, remoteSlug: string, uuidId: string | null): void {
  if (!uuidId) return;
  const dir = join(projects, remoteSlug);
  const uuidDir = join(projects, identitySlug(uuidId));
  if (uuidDir === dir || !existsSync(uuidDir) || !holdsProjectData(uuidDir)) return;
  const recordFile = join(dir, STRANDED_DATA_FILE);
  if (existsSync(recordFile)) {
    try {
      const existing = JSON.parse(readFileSync(recordFile, "utf8")) as StrandedDataRecord;
      if (existing.source === uuidDir) return;
    } catch {
      // An unreadable record is as good as absent: fall through and rewrite it.
    }
  }
  const record: StrandedDataRecord = {
    source: uuidDir,
    destination: dir,
    recordedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(uuidDir, "migration.log"), `Stranded data recorded: ${uuidDir} holds older data; ${remoteSlug} is the project's live directory.\n`, { flag: "a", mode: 0o600 });
  } catch {
    // A record that cannot be written must never break identity resolution.
  }
}

/**
 * Reads the stranded-data record for a resolved project directory (#1217),
 * or null. The record is reported only while it describes a live situation
 * (#1243): the source exists, still holds project data, and has not been
 * durably acknowledged. A resolved situation is simply not shown — the user
 * who acts outside moh is not nagged either.
 */
export function readStrandedDataRecord(dir: string): StrandedDataRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, STRANDED_DATA_FILE), "utf8")) as StrandedDataRecord;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.source !== "string" || typeof parsed.destination !== "string") return null;
    if (parsed.acknowledgedAt) return null;
    if (!existsSync(parsed.source) || !holdsProjectData(parsed.source)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * #1243 `k`: durably acknowledges the record ("keep it and stop warning")
 * so it is never reported again — until a genuinely new stranded situation
 * replaces it. Atomic (temp + rename, owner-only), idempotent: the first
 * acknowledgement's timestamp wins.
 */
export function acknowledgeStrandedData(dir: string): void {
  const file = join(pathResolve(dir), STRANDED_DATA_FILE);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as StrandedDataRecord;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.source !== "string") return;
  if (parsed.acknowledgedAt) return;
  parsed.acknowledgedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Advisory classification of the stranded source directory (#1243): what
 * a delete or move would touch, per entry kind. Never decides anything. */
export interface StrandedDataSummary {
  source: string;
  destination: string;
  /** Entries whose name is absent in the live directory. */
  onlyHere: string[];
  /** Same name and same size in both directories — probably identical. */
  sameSize: string[];
  /** Same name, different size. */
  differing: string[];
}

const STRANDED_NON_DATA = new Set(["migration.log", ".DS_Store"]);

/**
 * #1243: read-only cost summary for the resolution overlay. `statSync`
 * only — hundreds of megabytes of session logs must not be read to open a
 * modal. `.DS_Store` and `migration.log` are excluded from every count.
 */
export function strandedDataSummary(dir: string): StrandedDataSummary | null {
  const record = readStrandedDataRecord(dir);
  if (!record) return null;
  const summary: StrandedDataSummary = { source: record.source, destination: record.destination, onlyHere: [], sameSize: [], differing: [] };
  let destNames: Set<string>;
  try {
    destNames = new Set(readdirSync(record.destination));
  } catch {
    destNames = new Set();
  }
  let names: string[];
  try {
    names = readdirSync(record.source);
  } catch {
    return summary;
  }
  for (const name of names) {
    if (STRANDED_NON_DATA.has(name)) continue;
    let size = 0;
    try {
      size = statSync(join(record.source, name)).size;
    } catch {
      continue;
    }
    if (!destNames.has(name)) {
      summary.onlyHere.push(name);
      continue;
    }
    try {
      if (statSync(join(record.destination, name)).size === size) summary.sameSize.push(name);
      else summary.differing.push(name);
    } catch {
      summary.onlyHere.push(name);
    }
  }
  for (const key of ["onlyHere", "sameSize", "differing"] as const) summary[key].sort();
  return summary;
}

/** rename when possible (atomic, same volume), copy+unlink across devices. */
function moveStrandedFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/**
 * #1243 `m`: moves the session logs that exist only in the stranded source
 * into the live project directory — a self-contained log whose name is its
 * identity, no reconciliation problem. A same-name log already in the live
 * directory stays behind untouched (identical bytes are dropped from the
 * source; a differing one is reported, never overwritten). Does not clear
 * the record: the old directory usually still holds memory, notes, handoff.
 */
export function moveStrandedSessions(dir: string): { moved: string[]; skipped: string[]; dropped: string[] } {
  const record = readStrandedDataRecord(dir);
  if (!record) throw new Error(`moveStrandedSessions: no live stranded-data record for ${dir}`);
  const result: { moved: string[]; skipped: string[]; dropped: string[] } = { moved: [], skipped: [], dropped: [] };
  for (const name of readdirSync(record.source)) {
    if (!isSessionFile(name)) continue;
    const from = join(record.source, name);
    const to = join(record.destination, name);
    if (!existsSync(to)) {
      moveStrandedFile(from, to);
      result.moved.push(name);
      continue;
    }
    let fromBytes: Buffer;
    let toBytes: Buffer;
    try {
      if (statSync(from).size !== statSync(to).size) throw new Error("differing");
      fromBytes = readFileSync(from);
      toBytes = readFileSync(to);
    } catch {
      result.skipped.push(name);
      continue;
    }
    if (fromBytes.equals(toBytes)) {
      unlinkSync(from);
      result.dropped.push(name);
    } else {
      result.skipped.push(name);
    }
  }
  return result;
}

/**
 * #1243 `d`: deletes the stranded source directory. Its session logs go to
 * the project trash (restorable with `moh trash restore`); every other
 * entry is removed from disk; the record is cleared so the warning goes
 * away. Refuses anything that is not a stranded directory under
 * `<home>/.moh/projects/` — never the live project directory itself.
 */
export function deleteStrandedData(dir: string, cwd: string, home = homedir()): { trashed: number; removed: string[] } {
  const record = readStrandedDataRecord(dir);
  if (!record) throw new Error(`deleteStrandedData: no live stranded-data record for ${dir}`);
  const projectsRoot = join(pathResolve(home), ".moh", "projects");
  const source = pathResolve(record.source);
  if (source === pathResolve(dir) || !source.startsWith(projectsRoot + sep)) {
    throw new Error(`deleteStrandedData: refusing to delete ${source} — not a stranded directory under ${projectsRoot}`);
  }
  const trashDir = projectTrashDir(cwd, home);
  mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  let trashed = 0;
  const removed: string[] = [];
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    if (isSessionFile(name)) {
      let to = join(trashDir, name);
      for (let n = 1; existsSync(to); n++) to = join(trashDir, `${name.slice(0, -".jsonl".length)}-${n}.jsonl`);
      moveStrandedFile(from, to);
      trashed++;
    } else {
      rmSync(from, { recursive: true });
      removed.push(name);
    }
  }
  rmSync(source, { recursive: true });
  unlinkSync(join(pathResolve(dir), STRANDED_DATA_FILE));
  return { trashed, removed };
}
