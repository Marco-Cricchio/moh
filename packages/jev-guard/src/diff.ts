/**
 * The quality gate's diff collection (#789): the unified diff of the
 * files a task actually changed, via git — no new dependency, the same
 * spawnSync pattern as the guardrail's snapshot.
 *
 * The diff is taken against the head captured at evaluation time (the
 * best available anchor without a turn-start capture seam), restricted
 * to the paths the task wrote or edited. Outside a repo, or with an unreadable
 * diff, the gate is inert for the turn (ratified).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const GIT_TIMEOUT_MS = 2000;

function git(args: string[], cwd: string): string | null {
  const out = spawnSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  if (out.error !== undefined) return null;
  // Status 0 = clean; status 1 = "differences found" for the diff forms.
  return out.status === 0 || out.status === 1 ? out.stdout.toString() : null;
}

/** True when `cwd` is inside a git work tree. */
export function inGitRepo(cwd: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], cwd)?.trim() === "true";
}

/**
 * The turn's starting head. `null` outside a repo (or on an unborn
 * branch with no commits yet — nothing to diff against, gate inert).
 */
export function captureHead(cwd: string): string | null {
  const head = git(["rev-parse", "HEAD"], cwd);
  const trimmed = head?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The unified diff of `paths` (repo-relative, or best-effort as given)
 * against `head`. `null` = unreadable diff → gate inert.
 *
 * Covers both shapes a task produces: edits to tracked files (a plain
 * `git diff <head>` per path) and brand-new files (still untracked —
 * `git diff` shows them as empty, so each untracked path gets an
 * explicit "new file" hunk assembled from its content via
 * `git diff --no-index`).
 */
export function taskDiff(cwd: string, head: string, paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const chunks: string[] = [];
  const tracked: string[] = [];
  for (const p of paths) {
    // #851: repository scoping enforced here too, independently of the
    // caller — an absolute path that resolves outside the work tree is
    // never diffed (`--no-index` would happily compare it).
    if (isAbsolute(p)) {
      const rel = relative(cwd, p);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    }
    // `ls-files --error-unmatch` succeeds only for tracked paths; the
    // untracked failure exits 1 with empty output (and the shared `git`
    // helper maps exit 1 to ""), so the non-empty check is the test.
    const trackedOut = git(["ls-files", "--error-unmatch", p], cwd);
    if (trackedOut !== null && trackedOut.trim() !== "") {
      tracked.push(p);
      continue;
    }
    // Untracked: diff the empty device against the file — the portable
    // two-file form of a canonical "new file" hunk. Skipped when the
    // file does not exist (a path the task never successfully wrote).
    if (!existsSync(isAbsolute(p) ? p : join(cwd, p))) continue;
    const newDiff = git(["diff", "--no-color", "--no-index", "--", "/dev/null", p], cwd);
    if (newDiff !== null && newDiff.trim() !== "") chunks.push(newDiff);
  }
  if (tracked.length > 0) {
    const diff = git(["diff", head, "--no-color", "--", ...tracked], cwd);
    if (diff === null) return null;
    if (diff.trim() !== "") chunks.unshift(diff);
  }
  return chunks.length > 0 ? chunks.join("\n") : null;
}
