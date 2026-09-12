import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * MPM handoff warm-up priority (#620, spec #613): the receiving checkout
 * never receives MPM data with a handoff — the handoff artifact stays
 * metadata about files and tests only. What reception CAN do is hand the
 * handoff's touched-file/test paths to the local MPM lifecycle as a
 * warm-up priority, after validating each hint against the local
 * checkout. Validation is mandatory and local: a hint that is missing,
 * outside the root, or a symlink escape is dropped, never trusted.
 *
 * Everything here is non-blocking: building the priority list reads only
 * path metadata (stat), never file content, and never performs or waits
 * for any map work — the MPM lifecycle remains the sole owner of the
 * actual refresh schedule.
 */

/** The handoff hints usable for warm-up (already capped by the artifact). */
export interface HandoffWarmupHints {
  files?: string[];
  tests?: string[];
}

/** Extracts path-like tokens from test-looking commands (best effort). */
export function pathsFromTestCommands(tests: string[]): string[] {
  const out: string[] = [];
  for (const command of tests) {
    for (const match of command.matchAll(/[A-Za-z0-9_@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|php|lua|sh|c|h|cpp|hpp|cs|swift|kt)\b/g)) {
      out.push(match[0]);
    }
  }
  return out;
}

/**
 * Validates handoff hints against the receiving checkout and returns the
 * root-relative paths worth prioritizing for a local MPM warm-up, in
 * first-seen order (handoff order is the recency signal). A hint is kept
 * only when it resolves to an existing file inside the root without
 * leaving it via `..` segments or symlink-style escapes. Never throws.
 */
export function validatedWarmupPaths(root: string, hints: HandoffWarmupHints): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const raw = [...(hints.files ?? []), ...pathsFromTestCommands(hints.tests ?? [])];
  for (const hint of raw) {
    // Absolute hints that live inside the root are relativized; anything
    // else (other machine's absolute path) is meaningless here.
    let rel = hint;
    if (isAbsolute(hint)) {
      const r = relative(root, hint);
      if (!r || r.startsWith("..") || isAbsolute(r)) continue;
      rel = r;
    }
    rel = rel.replace(/\\/g, "/").replace(/^[./]+/, "").replace(/[.,;:)]+$/, "");
    if (!rel || rel.split("/").includes("..")) continue;
    if (seen.has(rel)) continue;
    try {
      const abs = join(root, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/**
 * A non-blocking warm-up priority: the receiving side hands these paths
 * to its local MPM lifecycle as immediate targeted refreshes (the same
 * highest-priority queue moh's own edits use). No map work happens here
 * and the call never blocks the handoff opening — the lifecycle's
 * budgets and busy-turn yielding still govern the actual work.
 */
export function requestWarmup(service: { refresh(root: string, path: string): void }, root: string, paths: string[]): void {
  for (const path of paths) {
    try {
      service.refresh(root, path);
    } catch {
      // Warm-up is best-effort: a failed refresh just costs coverage.
    }
  }
}

/** True when the path stays inside `root` (defense in depth for callers). */
export function staysInsideRoot(root: string, abs: string): boolean {
  const r = relative(root, abs);
  return !!r && !r.startsWith("..") && !isAbsolute(r) && !r.includes(`..${sep}`);
}
