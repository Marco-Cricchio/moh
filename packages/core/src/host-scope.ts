/**
 * ADR-0064 + ADR-0065: filesystem and host matching algorithms delegated
 * to by the shared check-scope module. Every `ctx.host.*` file operation traverses
 * `checkPathScope` before the host performs it; refusals are typed
 * results, never exceptions. Pure module: containment decides, the
 * runtime (extensions.ts) performs and logs.
 *
 * Decisions owned here:
 * - one grant covers the whole file family (read/write/append/rename/
 *   delete) — the op is never re-checked against a narrower scope;
 * - picomatch-style globs, project-root-relative; an absolute path in a
 *   manifest capability is invalid and fails loudly at load;
 * - `..` segments are rejected before resolution; symlinks are resolved
 *   and the resolved target is what the scope checks; case follows the
 *   real filesystem, **per path component**, and a case-insensitive
 *   match folds the glob's literal letters without ever rewriting its
 *   classes or ranges.
 */
import { readdirSync, realpathSync, lstatSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";

/** Exactly-case glob match; a malformed pattern refuses rather than throws. */
function globMatchesExactly(glob: string, rel: string): boolean {
  try {
    return new Bun.Glob(glob).match(rel);
  } catch {
    return false;
  }
}

export function globMatches(glob: string, rel: string, foldAllowed: boolean): boolean {
  if (glob === rel) return true;
  if (!foldAllowed) return globMatchesExactly(glob, rel);
  const folded = foldGlobCase(glob);
  if (folded === null || folded === glob) return globMatchesExactly(glob, rel);
  // The folded match is the case-insensitive reading of the pattern: it
  // widens literal letters to both cases and touches nothing else, so it
  // is a superset of the exact match for a positive pattern and a subset
  // for a negated one. A negated grant must not be widened by the exact
  // reading alone — `path:!src/**` still excludes `SRC/a.ts` on an
  // insensitive filesystem — so the folded answer is authoritative
  // whenever it exists; the exact match remains for positive patterns
  // only, as a belt on exotic patterns this fold may under-approximate.
  if (globMatchesExactly(folded, rel)) return true;
  return isNegatedPattern(glob) ? false : globMatchesExactly(glob, rel);
}

/** An odd leading `!` run negates the whole pattern (Bun.Glob dialect). */
function isNegatedPattern(glob: string): boolean {
  let bangs = 0;
  while (glob[bangs] === "!") bangs++;
  return bangs % 2 === 1;
}

/**
 * Syntax-preserving case fold of one glob: every bare ASCII letter
 * becomes its two-case class (`s` → `[sS]`), while character classes,
 * ranges, negations, braces, wildcards and separators are copied
 * verbatim. Lowercasing the whole pattern is what made `[!A-z]` into
 * `[!a-z]` — a different set (`_.txt` flips from excluded to admitted),
 * i.e. an over-grant. `null` when the pattern carries an escape (`\`),
 * whose literal meaning two-case expansion cannot preserve: the caller
 * then stays exact instead of guessing.
 */
export function foldGlobCase(pattern: string): string | null {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") return null;
    if (ch === "[") {
      let j = i + 1;
      if (pattern[j] === "!" || pattern[j] === "^") j++;
      // A `]` immediately after the opening bracket (or after `!`/`^`)
      // is a literal member, not the class terminator.
      if (pattern[j] === "]") j++;
      const close = pattern.indexOf("]", j);
      if (close === -1) {
        out += ch;
        continue;
      }
      out += pattern.slice(i, close + 1);
      i = close;
      continue;
    }
    out += (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")
      ? `[${ch.toLowerCase()}${ch.toUpperCase()}]`
      : ch;
  }
  return out;
}

/** realpath when the target exists; otherwise the nearest existing ancestor with the tail appended. */
export function resolveReal(abs: string): string {
  let dir = abs;
  const tail: string[] = [];
  for (;;) {
    if (lstatSafe(dir)) {
      try {
        return joinParts(realpathSync(dir), tail.reverse());
      } catch {
        // A dangling or looping symlink: the lexical path is all the
        // filesystem can state, so containment falls back to it — the
        // check itself stays fail-closed on the glob.
        return abs;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return abs;
    tail.push(dir.slice(dir.lastIndexOf("/") + 1));
    dir = parent;
  }
}

function lstatSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function joinParts(base: string, parts: string[]): string {
  return parts.length === 0 ? base : `${base}/${parts.join("/")}`;
}

/** Read-only case probe. Compare canonical paths, not merely existence:
 * two distinct case-sensitive names (or hardlinks) must never imply an
 * insensitive filesystem. No temporary files or platform assumptions.
 * With no observable spelling difference, conservatively stay strict.
 */
export function caseInsensitiveAt(directory: string): boolean {
  let current = directory;
  while (!lstatSafe(current)) {
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  try {
    current = realpathSync(current);
    const device = statSync(current).dev;
    for (;;) {
      for (const entry of readdirSync(current)) {
        if (lstatSync(join(current, entry)).isSymbolicLink()) continue;
        const alternate = swapCase(entry);
        if (alternate === entry) continue;
        try {
          if (lstatSync(join(current, alternate)).isSymbolicLink()) return false;
          return realpathSync(join(current, alternate)) === realpathSync(join(current, entry));
        } catch {
          return false;
        }
      }
      // An empty directory has no entry to probe. Its own spelling in
      // the parent provides evidence on the same filesystem only.
      const parent = dirname(current);
      if (parent === current || statSync(parent).dev !== device) return false;
      const alternate = swapCase(basename(current));
      if (alternate !== basename(current)) {
        try {
          if (lstatSync(join(parent, alternate)).isSymbolicLink()) return false;
          return realpathSync(join(parent, alternate)) === current;
        }
        catch { return false; }
      }
      current = parent;
    }
  } catch {
    return false;
  }
}

function swapCase(name: string): string {
  return name.replace(/[a-zA-Z]/, (letter) => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
}

/**
 * ADR-0066: the fixed size limit for a buffered fetch response (1 MiB
 * default). No streaming in this phase: the host reads the body fully or
 * refuses it as `too_large`.
 */
export const MAX_FETCH_BYTES = 1024 * 1024;
/** Redirect hops followed inside the allowlist before refusing. */
export const MAX_REDIRECTS = 5;
