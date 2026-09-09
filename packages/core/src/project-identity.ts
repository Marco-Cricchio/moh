import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { anyOpenSessionInDir } from "./session-store";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve as pathResolve } from "node:path";

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

/**
 * Canonical origin remote identity: `host/owner/repo`, lowercased, with the
 * protocol, credentials, port-less host, and trailing `.git` normalized away
 * (#591). Returns null when there is no origin or it cannot be parsed.
 */
export function canonicalRemoteSlug(cwd: string): string | null {
  let url: string;
  try {
    url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
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
  return `${host.toLowerCase()}/${repo}`;
}

/**
 * In-process pin: the first slug resolution for a project wins for the
 * process lifetime, so a mid-session slug re-evaluation can never split a
 * project's data across two directories (#591).
 */
const pinnedSlugs = new Map<string, { slug: string; legacySlug: string; declared: boolean }>();

/**
 * Resolves the stable project identity and migrates pre-#398 data once.
 * An unreadable identity deliberately leaves the project on its legacy slug.
 * When the project has a git `origin` remote, the slug derives from its
 * canonical `host/owner/repo` form so clones on different machines share one
 * identity (#591); otherwise the uuid-derived identity applies.
 */
export function resolveProjectIdentity(cwd: string, home: string): { slug: string; legacySlug: string; declared: boolean } {
  const legacySlug = legacyProjectSlug(cwd);
  const key = `${pathResolve(cwd)}\u0000${pathResolve(home)}`;
  const pinned = pinnedSlugs.get(key);
  if (pinned) return pinned;

  const result = resolveProjectIdentityUncached(cwd, home, legacySlug);
  pinnedSlugs.set(key, result);
  return result;
}

function resolveProjectIdentityUncached(cwd: string, home: string, legacySlug: string): { slug: string; legacySlug: string; declared: boolean } {
  const remoteSlug = canonicalRemoteSlug(cwd);
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
      // Materialize the project directory (owner-only) so the first session
      // or memory write cannot race with the mode-tightening rules: only
      // newly created directories get 0o700, existing ones are untouched.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
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
