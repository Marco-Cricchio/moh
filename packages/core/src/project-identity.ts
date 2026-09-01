import { createHash, randomUUID } from "node:crypto";
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
 * Resolves the stable project identity and migrates pre-#398 data once.
 * An unreadable identity deliberately leaves the project on its legacy slug.
 */
export function resolveProjectIdentity(cwd: string, home: string): { slug: string; legacySlug: string; declared: boolean } {
  const legacySlug = legacyProjectSlug(cwd);
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
