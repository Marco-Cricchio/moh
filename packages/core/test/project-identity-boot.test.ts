/**
 * #939: the identity boot seam.
 *
 * Resolving the project identity spawns `git remote get-url` synchronously,
 * and under bun a synchronous spawn runs the event loop *inside* the call.
 * Reached from a React render or commit window, a queued scheduler task
 * re-enters the reconciler ("Should not already be working.", ADR-0024) and
 * Ink dies. The seam makes that impossible by construction: the identity is
 * resolved once, before the tree that needs it mounts, and every later
 * resolution is memory-served.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProjectIdentityPrepared,
  prepareProjectIdentity,
  prepareProjectIdentityNow,
} from "../src/index";
import { projectSlug } from "../src/session-store";

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A repo with a git origin: the shape that takes the spawn path. */
function repoWithOrigin(url = "git@github.com:owner/repo.git"): string {
  const dir = tempDir("moh-939-repo-");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
  return dir;
}

/** Counts synchronous spawns while `body` runs. */
function countingSyncSpawns<T>(body: () => T): { result: T; spawns: number } {
  const real = Bun.spawnSync;
  let spawns = 0;
  (Bun as { spawnSync: unknown }).spawnSync = ((...args: unknown[]) => {
    spawns++;
    return (real as (...a: unknown[]) => unknown)(...args);
  }) as never;
  try {
    return { result: body(), spawns };
  } finally {
    (Bun as { spawnSync: unknown }).spawnSync = real;
  }
}

describe("prepareProjectIdentity (#939)", () => {
  test("resolves without a synchronous spawn and makes every later resolution spawn-free", async () => {
    const cwd = repoWithOrigin();
    const home = tempDir("moh-939-home-");

    expect(isProjectIdentityPrepared(cwd, home)).toBe(false);

    const counted = countingSyncSpawns(() => {
      const pending = prepareProjectIdentity(cwd, home);
      return pending;
    });
    await counted.result;
    expect(counted.spawns).toBe(0);
    expect(isProjectIdentityPrepared(cwd, home)).toBe(true);

    // The point of the seam: from here on the answers come from memory, so
    // nothing on a React path can spawn — whatever is pending.
    const after = countingSyncSpawns(() => projectSlug(cwd, home));
    expect(after.spawns).toBe(0);
  });

  test("agrees with the synchronous resolver it replaces", async () => {
    const cwd = repoWithOrigin("https://gitlab.com/group/sub/proj.git");
    const home = tempDir("moh-939-home-");
    const awaited = (await prepareProjectIdentity(cwd, home)).slug;
    const prepared = prepareProjectIdentityNow(repoWithOrigin("https://gitlab.com/group/sub/proj.git"), home).slug;
    expect(awaited).toBe("gitlab.com/group/sub/proj");
    expect(prepared).toBe(awaited);
  });

  test("prepareProjectIdentityNow is the entry-point twin: same slug, no await", () => {
    const cwd = repoWithOrigin();
    const home = tempDir("moh-939-home-");
    const result = prepareProjectIdentityNow(cwd, home);
    expect(isProjectIdentityPrepared(cwd, home)).toBe(true);
    expect(projectSlug(cwd, home)).toBe(result.slug);
  });

  test("a project without an origin still prepares and pins a stable identity", async () => {
    const cwd = tempDir("moh-939-plain-");
    const home = tempDir("moh-939-home-");
    const prepared = await prepareProjectIdentity(cwd, home);
    expect(prepared.slug).toMatch(/^project-[0-9a-f]{16}$/);
    expect(projectSlug(cwd, home)).toBe(prepared.slug);
  });
});
