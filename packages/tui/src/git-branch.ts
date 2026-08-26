/**
 * Git branch for the status bar: a pure filesystem read (no process
 * spawn), so it stays cheap enough to poll on the TUI render path.
 * Walks up from the session cwd like git does; understands
 * worktrees/submodules (`.git` as a gitdir pointer file) and detached
 * HEADs (short sha). Chrome-only: never a core concern.
 */
import { useEffect, useState } from "react";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Reads the current branch name (or short sha when detached); `null`
 * when the cwd is not inside a git work tree. */
export function readGitBranch(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    const branch = readHeadAt(dir);
    if (branch !== null) return branch;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parses `.git/HEAD` under `dir`; `null` when there is no readable
 * repository at that level (the caller walks up). */
function readHeadAt(dir: string): string | null {
  let headFile: string;
  try {
    const dotGit = join(dir, ".git");
    if (statSync(dotGit).isDirectory()) {
      headFile = join(dotGit, "HEAD");
    } else {
      // Worktree / submodule: `.git` is a `gitdir: <path>` pointer file.
      const match = /^gitdir:\s*(.+)$/.exec(readFileSync(dotGit, "utf8").trim());
      if (!match) return null;
      const gitDir = isAbsolute(match[1]!) ? match[1]! : join(dir, match[1]!);
      headFile = join(gitDir, "HEAD");
    }
    const head = readFileSync(headFile, "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
    // Detached HEAD: the object sha, shown truncated.
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}

/** Branch label for the status bar, refreshed from the filesystem. The
 * agent (or the user in another terminal) may switch branches mid-session,
 * so a cheap poll keeps the label honest; identical values bail out of
 * React's state update, so a quiet repository costs no re-render. */
export function useGitBranch(cwd: string): string | null {
  const [branch, setBranch] = useState<string | null>(() => readGitBranch(cwd));
  useEffect(() => {
    setBranch(readGitBranch(cwd));
    const timer = setInterval(() => {
      const next = readGitBranch(cwd);
      setBranch((current) => (current === next ? current : next));
    }, 5000);
    return () => clearInterval(timer);
  }, [cwd]);
  return branch;
}
