/**
 * ADR-0064 + ADR-0065: the one check-scope module behind the host-tool
 * seam's `path:<glob>` scope. Every `ctx.host.*` file operation traverses
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
 *   real filesystem.
 */
import { readdirSync, realpathSync, lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname } from "node:path";

/** The only scope prefix phase F1 (ADR-0071) makes a known slot. */
export const PATH_SCOPE_PREFIX = "path:";

/** True when the capability string is a path scope (`path:<glob>`). */
export function isPathScope(capability: string): boolean {
  return capability.startsWith(PATH_SCOPE_PREFIX);
}

/** The glob half of a `path:<glob>` scope string. */
export function pathScopeGlob(capability: string): string {
  return capability.slice(PATH_SCOPE_PREFIX.length);
}

export type PathScopeValidity = { ok: true; glob: string } | { ok: false; reason: "malformed" | "absolute"; message: string };

/**
 * Load-time validation of one `path:<glob>` capability. An absolute path
 * in a manifest capability fails loudly (ADR-0065): a capability naming
 * outside-the-project targets is exactly what consent must not hide.
 */
export function validatePathScope(capability: string): PathScopeValidity {
  const glob = pathScopeGlob(capability);
  if (glob.trim() === "" || glob.includes("\0")) {
    return { ok: false, reason: "malformed", message: `invalid path scope "${capability}": empty or malformed glob` };
  }
  if (isAbsolute(glob)) {
    return { ok: false, reason: "absolute", message: `invalid path scope "${capability}": absolute paths are not allowed — scopes are project-root-relative` };
  }
  return { ok: true, glob };
}

/** All path scopes in a capability grant (order preserved). */
export function pathScopesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter(isPathScope);
}

/**
 * The core-owned effect-sentence renderer (ADR-0064): a scope becomes one
 * concrete sentence the consent question shows — never the naked string
 * alone. `null` for capabilities this renderer does not speak (the
 * existing slots render as before).
 */
export function scopeEffectSentence(capability: string): string | null {
  if (!isPathScope(capability)) return null;
  const check = validatePathScope(capability);
  const glob = check.ok ? check.glob : pathScopeGlob(capability);
  return `may read and modify files under \`${glob}\`, including create, rename, delete`;
}

/** Effect sentences for every scope in a grant, in order. */
export function scopeEffectSentences(capabilities: readonly string[]): string[] {
  return capabilities
    .map(scopeEffectSentence)
    .filter((s): s is string => s !== null);
}

export type PathScopeCheck =
  | { ok: true; resolved: string }
  | { ok: false; reason: "outside_scope" | "invalid_path" | "denied"; resolved?: string };

/**
 * Real-filesystem containment (ADR-0065): `..` segments are rejected
 * before resolution; the resolved target (symlinks followed, case as the
 * filesystem holds it) must sit inside the project root AND match at
 * least one granted glob. The resolved path travels back for the log —
 * the log records the real target, never the requested path.
 *
 * `isDenied` (the user's deny rules, bound per call by the session) wins
 * over every grant — the grant never widens what moh itself may do.
 */
export function checkPathScope(
  requestedPath: string,
  scopes: readonly string[],
  projectRoot: string,
  isDenied: (resolvedAbsPath: string) => boolean,
): PathScopeCheck {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "" || requestedPath.includes("\0")) {
    return { ok: false, reason: "invalid_path" };
  }
  // `..` rejected before resolution: a lexical escape is refused as a
  // policy answer even when the target happens to exist.
  const raw = isAbsolute(requestedPath) ? relative(projectRoot, requestedPath) : requestedPath;
  const segments = raw.split(/[/\\]+/).filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    return { ok: false, reason: "outside_scope" };
  }
  const abs = resolve(projectRoot, ...segments);
  // Symlinks resolved to the checked target: an existing path is checked
  // through realpath; a not-yet-existing path checks through its nearest
  // existing ancestor (creation inside an escaping symlinked directory is
  // still caught — the parent is the real target).
  const resolved = resolveReal(abs);
  const rel = relative(realpathSync(projectRoot), resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: "outside_scope", resolved };
  }
  // Case follows the filesystem (insensitive on APFS, sensitive on
  // Linux): re-check with the true-cased path when the direct match
  // fails, so a grant matches the path as the FS spells it.
  if (!matchesAnyScope(rel, scopes) && !matchesAnyScope(trueCaseRel(realpathSync(projectRoot), rel), scopes)) {
    return { ok: false, reason: "outside_scope", resolved };
  }
  if (isDenied(resolved)) {
    return { ok: false, reason: "denied", resolved };
  }
  return { ok: true, resolved };
}

function matchesAnyScope(rel: string, scopes: readonly string[]): boolean {
  return scopes.some((capability) => {
    const check = validatePathScope(capability);
    if (!check.ok) return false;
    try {
      return check.glob === rel || new Bun.Glob(check.glob).match(rel);
    } catch {
      return false;
    }
  });
}

/** realpath when the target exists; otherwise the nearest existing ancestor with the tail appended. */
function resolveReal(abs: string): string {
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

/**
 * True-cased relative path: walks existing directory levels and re-spells
 * each segment as the filesystem lists it. Bounded to the existing
 * prefix; a missing tail keeps its requested spelling.
 */
function trueCaseRel(resolvedAbs: string, rel: string): string {
  const parts = rel.split("/");
  const cased: string[] = [];
  let current = dirname(resolvedAbs.split("/").slice(0, resolvedAbs.split("/").length - parts.length + 1).join("/"));
  for (let i = 0; i < parts.length; i++) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return rel;
    }
    const found = entries.find((e) => e.toLowerCase() === parts[i]!.toLowerCase());
    if (found === undefined) return rel;
    cased.push(found);
    current = `${current}/${found}`;
  }
  return cased.join("/");
}
