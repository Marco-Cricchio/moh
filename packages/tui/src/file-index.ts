import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// #488 (vision note 3): the TUI `@` popup's file index. Git repositories
// index synchronously (`git ls-files` — gitignore-respecting, ~ms even on
// large repos) at every popup open; outside git the popup opens as soon as
// an async walk starts producing paths. No persistent cache; matching is
// fuzzy, in memory, capped.

/** Result cap for the popup list (#488: the file must be findable even among thousands). */
export const MENTION_POPUP_CAP = 50;

/**
 * Fuzzy-ranks paths against a query (case-insensitive subsequence over the
 * path's basename first, then the whole path; contiguous runs and word
 * boundaries score higher). Caller order breaks ties. Capped results.
 */
export function fuzzyRank(paths: readonly string[], query: string, cap = MENTION_POPUP_CAP): string[] {
  if (!query) return paths.slice(0, cap);
  const lowerQuery = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    const score = fuzzyScore(path, lowerQuery);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, cap).map((entry) => entry.path);
}

function fuzzyScore(path: string, lowerQuery: string): number | null {
  const lowerPath = path.toLowerCase();
  const base = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
  const baseScore = subsequenceScore(base, lowerQuery, true);
  const pathScore = subsequenceScore(lowerPath, lowerQuery, false);
  if (baseScore === null && pathScore === null) return null;
  // Basename matches beat whole-path matches; higher is better.
  return Math.max(baseScore === null ? -1 : baseScore * 2 + 10, pathScore ?? -1);
}

function subsequenceScore(text: string, query: string, boundaryBonus: boolean): number | null {
  let score = 0;
  let at = 0;
  for (const char of query) {
    const found = text.indexOf(char, at);
    if (found === -1) return null;
    score += found === at ? 2 : 1; // contiguous runs score higher
    if (boundaryBonus && (found === 0 || /[-_./]/.test(text[found - 1] ?? ""))) score += 1;
    at = found + 1;
  }
  return score;
}

const WALK_SKIP = new Set([".git", "node_modules", ".moh", "dist", ".next"]);

/**
 * The popup's path list: git repositories resolve via `git ls-files
 * --cached --others --exclude-standard` (respects gitignore); anything
 * else falls back to a recursive walk (skipping heavy/noise directories).
 * Relative paths, `/`-separated. Fully asynchronous: a spawn inside a
 * React effect would block the reconciler's commit phase (Ink tests hang
 * on "Should not already be working").
 */
export async function listFiles(cwd: string): Promise<string[]> {
  try {
    const out = await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd });
      const chunks: Buffer[] = [];
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.on("error", reject);
      proc.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ls-files exited ${code}`)));
    });
    return out.toString().split("\n").filter(Boolean);
  } catch {
    return walk(cwd, "");
  }
}

async function walk(dir: string, prefix: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (WALK_SKIP.has(entry.name)) continue;
      results.push(...(await walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name)));
    } else if (entry.isFile()) {
      results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  }
  return results;
}
