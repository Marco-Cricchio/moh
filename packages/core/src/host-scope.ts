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


/**
 * The core-owned effect-sentence renderer (ADR-0064): a scope becomes one
 * concrete sentence the consent question shows — never the naked string
 * alone. `null` for capabilities this renderer does not speak (the
 * existing slots render as before).
 */
export function scopeEffectSentence(capability: string): string | null {
  if (isHostScope(capability)) {
    if (capability === TOTAL_HOST_WILDCARD) {
      return "may contact any host on the internet over https — total network access";
    }
    const check = validateHostScope(capability);
    if (!check.ok) return null;
    if (check.wildcard) {
      const parent = check.host.slice(2);
      const base = `may contact any subdomain of \`${parent}\` over https`;
      return check.port !== undefined ? `${base} on port ${check.port}` : base;
    }
    const named = `\`${check.host}${check.port !== undefined ? `:${check.port}` : ""}\` over https`;
    return `may contact ${named}`;
  }
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
  const requestHost = url.host; // host:port as the URL states it
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
