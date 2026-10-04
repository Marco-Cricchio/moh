/**
 * The quality gate's diff collection (#789): the unified diff of the
 * files a task actually changed, via git — crossing the host seam (T7,
 * #1165): every read is one `ctx.host.runTool("git", …)` call under the
 * extension's `tool:git` grant, logged like any host-performed operation.
 * The module takes a `GitRead` runner; it spawns nothing itself.
 *
 * The diff is taken against the head captured at evaluation time (the
 * best available anchor without a turn-start capture seam), restricted
 * to the paths the task wrote or edited. Outside a repo, or with an
 * unreadable diff (including a refused seam call — no grant, a deny
 * rule, an unknown tool on an older host), the gate is inert for the
 * turn (ratified fail-open: `null`).
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/**
 * One read-only git read. `null` = the read did not answer (refusal,
 * failure, off-repo) — the same meaning exit != 0 had over child
 * processes. Status 1 counts as an answer ("differences found" for the
 * diff forms), because the seam's tool result carries stdout regardless.
 */
export type GitRead = (args: readonly string[]) => Promise<string | null>;

export interface GitReader {
  /** True when the cwd is inside a git work tree. */
  inRepo(): Promise<boolean>;
  /** The turn's starting head; `null` outside a repo or on an unborn branch. */
  head(): Promise<string | null>;
  /** True when the path is tracked (`ls-files --error-unmatch`). */
  isTracked(path: string): Promise<boolean>;
  /** The new-file hunk for an untracked path (empty-string = no diff). */
  newFileDiff(path: string): Promise<string | null>;
  /** The tracked diff of `paths` against `head`; `null` = unreadable. */
  trackedDiff(head: string, paths: readonly string[]): Promise<string | null>;
}

/** The reader every GitRead-composing helper shares. */
export function createGitReader(read: GitRead): GitReader {
  const readAll = async (args: readonly string[]): Promise<string | null> => {
    const out = await read(args);
    return out === null ? null : out;
  };
  return {
    async inRepo() {
      return (await readAll(["rev-parse", "--is-inside-work-tree"]))?.trim() === "true";
    },
    async head() {
      const trimmed = (await readAll(["rev-parse", "HEAD"]))?.trim();
      return trimmed ? trimmed : null;
    },
    async isTracked(path) {
      // The failure exits 1 with empty output, mapped to null by the
      // runner; the non-empty check is the tracked test.
      const out = await readAll(["ls-files", "--error-unmatch", path]);
      return out !== null && out.trim() !== "";
    },
    async newFileDiff(path) {
      // The portable two-file form of a canonical "new file" hunk.
      const out = await readAll(["diff", "--no-color", "--no-index", "--", "/dev/null", path]);
      return out;
    },
    async trackedDiff(head, paths) {
      return readAll(["diff", head, "--no-color", "--", ...paths]);
    },
  };
}

/**
 * The unified diff of `paths` (repo-relative, or best-effort as given)
 * against `head`. `null` = unreadable diff → gate inert.
 *
 * Covers both shapes a task produces: edits to tracked files (a plain
 * `git diff <head>` per path) and brand-new files (still untracked —
 * `git diff` shows them as empty, so each untracked path gets an
 * explicit "new file" hunk assembled from its content).
 */
export async function taskDiff(
  read: GitRead,
  cwd: string,
  head: string,
  paths: readonly string[],
): Promise<string | null> {
  if (paths.length === 0) return null;
  const git = createGitReader(read);
  const chunks: string[] = [];
  const tracked: string[] = [];
  for (const p of paths) {
    // #851: repository scoping enforced here too, independently of the
    // caller's `scopePaths` (lint-gate.ts — the same containment check
    // in the same terms; keep the two in step) — an absolute path that
    // resolves outside the work tree is never diffed.
    if (isAbsolute(p)) {
      const rel = relative(cwd, p);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    }
    if (await git.isTracked(p)) {
      tracked.push(p);
      continue;
    }
    // Untracked: skipped when the file does not exist (a path the task
    // never successfully wrote).
    if (!existsSync(isAbsolute(p) ? p : join(cwd, p))) continue;
    const newDiff = await git.newFileDiff(p);
    if (newDiff !== null && newDiff.trim() !== "") chunks.push(newDiff);
  }
  if (tracked.length > 0) {
    const diff = await git.trackedDiff(head, tracked);
    if (diff === null) return null;
    if (diff.trim() !== "") chunks.unshift(diff);
  }
  return chunks.length > 0 ? chunks.join("\n") : null;
}
