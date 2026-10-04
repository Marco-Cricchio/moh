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
import { isAbsolute, relative, resolve, dirname, basename, join } from "node:path";

/** The scope prefixes the shipped host knows (ADR-0071: a prefix becomes
 * a known slot only when its phase ships — F1 `path:`, F2 `host:`). */
export const PATH_SCOPE_PREFIX = "path:";
export const HOST_SCOPE_PREFIX = "host:";

/** True when the capability string is a path scope (`path:<glob>`). */
export function isPathScope(capability: string): boolean {
  return capability.startsWith(PATH_SCOPE_PREFIX);
}

/** True when the capability string is a host scope (`host:<domain>`). */
export function isHostScope(capability: string): boolean {
  return capability.startsWith(HOST_SCOPE_PREFIX);
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

/** All host scopes in a capability grant (order preserved). */
export function hostScopesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter(isHostScope);
}

/**
 * The total wildcard (`host:*`) exists only with a manifest `reasoning`
 * string (ADR-0066, the Figma model): the author's justification the
 * consent question displays. moh never verifies the text — the owner
 * reads it and decides.
 */
export const TOTAL_HOST_WILDCARD = "host:*";
/** The manifest key carrying the total-wildcard justification. */
export const HOST_SCOPE_REASONING_KEY = "reasoning";

export type HostScopeValidity =
  | { ok: true; host: string; port?: number; wildcard: boolean }
  | { ok: false; reason: "malformed"; message: string };

/**
 * Load-time validation of one `host:<domain>` capability (ADR-0066).
 * Identity is string equality with the URL host — no origin-pattern
 * grammar. `host:*.example.com` covers one label of subdomains as
 * written; an explicit port is allowed for development. https is
 * implicit and never spelled inside the string.
 */
export function validateHostScope(capability: string): HostScopeValidity {
  const spec = capability.slice(HOST_SCOPE_PREFIX.length);
  if (spec.trim() === "" || spec.includes("\0")) {
    return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": empty or malformed host` };
  }
  // Split the optional port off the last colon (IPv6 literals are not
  // part of this grammar — a bracketed literal refuses as malformed).
  const colon = spec.lastIndexOf(":");
  let hostPart = spec;
  let port: number | undefined;
  if (colon >= 0) {
    hostPart = spec.slice(0, colon);
    const portPart = spec.slice(colon + 1);
    if (!/^\d{1,5}$/.test(portPart)) {
      return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": port must be numeric` };
    }
    port = Number(portPart);
    if (port < 1 || port > 65535) {
      return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": port out of range` };
    }
  }
  if (hostPart !== "*") {
    // Lowercase letters, digits, hyphens, dots; single labels; `*.`
    // wildcard only as a whole leftmost label.
    if (!/^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(hostPart) || hostPart.includes("..")) {
      return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": not a hostname` };
    }
    // One wildcard label per scope: `*.*.example.com` refuses.
    if ((hostPart.match(/\*/g) ?? []).length > 1) {
      return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": at most one wildcard label` };
    }
  } else if (port !== undefined) {
    // The total wildcard is whole-network: pinning it to a port is a
    // grammar outside ADR-0066 (and would dodge the reasoning vocabulary).
    return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": the total wildcard takes no port` };
  }
  return { ok: true, host: hostPart, port, wildcard: hostPart.startsWith("*.") };
}

/**
 * The host a request URL must string-match against one validated scope
 * (ADR-0066: identity stays equality). The default https port is
 * implicit on both sides; an explicit default port in a request URL
 * normalizes to no port.
 */
export function hostMatchesScope(scope: HostScopeValidity & { ok: true }, url: URL): boolean {
  let requestHost = url.hostname.toLowerCase();
  const requestPort = url.port === "" || (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")
    ? undefined
    : Number(url.port);
  // https implicit: a scope without a port speaks https; an http request
  // URL matches only a development scope that spelled a port (local dev
  // servers), never a bare `host:<domain>` grant.
  if (url.protocol !== "https:") {
    if (scope.port === undefined) return false;
    if (scope.port !== requestPort) return false;
  } else if (scope.port !== undefined && scope.port !== requestPort) {
    return false;
  }
  if (scope.host === "*") return true;
  if (scope.wildcard) {
    const suffix = scope.host.slice(2); // strip `*.`
    // One label: the remainder before the suffix must be a single label.
    if (!requestHost.endsWith(`.${suffix}`)) return false;
    const prefix = requestHost.slice(0, requestHost.length - suffix.length - 1);
    return prefix !== "" && !prefix.includes(".");
  }
  return requestHost === scope.host;
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
  const root = realpathSync(projectRoot);
  const rel = relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: "outside_scope", resolved };
  }
  // Observe the target filesystem, not the OS: macOS can host sensitive
  // volumes and Linux can host insensitive ones. Missing tails inherit
  // the nearest existing directory's behavior.
  const components = rel.split("/").filter((s) => s !== "");
  const insensitive = components.map((_, i) => caseInsensitiveAt(join(root, ...components.slice(0, i))));
  if (!matchesPathScopes(rel, scopes, insensitive)) {
    return { ok: false, reason: "outside_scope", resolved };
  }
  if (isDenied(resolved)) {
    return { ok: false, reason: "denied", resolved };
  }
  return { ok: true, resolved };
}

/**
 * Whether one project-relative path matches any granted `path:<glob>`.
 *
 * `componentInsensitive[i]` is the case behavior of the directory that
 * *contains* path component `i` (`components[i-1]`'s directory, the root
 * for `i = 0`), as observed on the real filesystem. It is deliberately
 * per component: deriving one answer from the leaf directory and
 * applying it to the whole path let a sensitive ancestor (`SRC` on a
 * sensitive volume) match a request for `src` on the strength of an
 * insensitive mount deeper down the same path.
 *
 * Exported as the tests-only seam: `checkPathScope` computes the answers
 * from the filesystem, a test can hand in the mixed-mount shapes a plain
 * temp directory cannot produce.
 */
export function matchesPathScopes(rel: string, scopes: readonly string[], componentInsensitive: readonly boolean[]): boolean {
  // Fold only when *every* component of the resolved path sits on an
  // insensitive filesystem. A mixed path (a sensitive ancestor above an
  // insensitive mount, or the reverse) keeps exact-case matching: the
  // conservative answer is to require the spelling the scope wrote,
  // never to widen the grant on a partial answer.
  const fold = componentInsensitive.length > 0 && componentInsensitive.every(Boolean);
  return scopes.some((capability) => {
    if (!isPathScope(capability)) return false;
    const check = validatePathScope(capability);
    if (!check.ok) return false;
    return globMatches(check.glob, rel, fold);
  });
}

/** Exactly-case glob match; a malformed pattern refuses rather than throws. */
function globMatchesExactly(glob: string, rel: string): boolean {
  try {
    return new Bun.Glob(glob).match(rel);
  } catch {
    return false;
  }
}

function globMatches(glob: string, rel: string, foldAllowed: boolean): boolean {
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

/** Read-only case probe. Compare canonical paths, not merely existence:
 * two distinct case-sensitive names (or hardlinks) must never imply an
 * insensitive filesystem. No temporary files or platform assumptions.
 * With no observable spelling difference, conservatively stay strict.
 */
function caseInsensitiveAt(directory: string): boolean {
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

export type HostFetchCheck =
  | { ok: true }
  | { ok: false; reason: "outside_scope" | "invalid_url" | "denied"; target?: string };

/**
 * The per-call scope check for `host.fetch`: the request URL's host must
 * string-match at least one granted `host:` scope. The user's deny rules
 * beat the grant per call, keyed by the request host. Pure module: the
 * runtime (extensions.ts) performs the request and logs.
 */
export function checkHostScope(
  url: URL,
  scopes: readonly string[],
  isDenied: (host: string) => boolean,
): HostFetchCheck {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "invalid_url" };
  }
  const matched = scopes.some((capability) => {
    if (!isHostScope(capability)) return false;
    const check = validateHostScope(capability);
    return check.ok && hostMatchesScope(check, url);
  });
  if (!matched) {
    return { ok: false, reason: "outside_scope", target: url.host };
  }
  if (isDenied(url.hostname)) {
    return { ok: false, reason: "denied", target: url.host };
  }
  return { ok: true };
}
