import { readdirSync, readFileSync, statSync, lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * MPM workspace discovery (#615): deterministic, safety-first enumeration of
 * candidate files under a project root. The result is the conservative
 * candidate set for extraction — sensitive, generated, vendor, binary,
 * oversize, and outside-root inputs are excluded before any extractor runs.
 * Metadata only: no file content is returned or retained here.
 */

/** Hard upper bound on any file considered for extraction. */
export const MPM_MAX_FILE_SIZE = 512 * 1024;

/**
 * MPM-specific directory exclusions — always skipped regardless of
 * .gitignore content. Generated output, package internals, and VCS state
 * are structural noise by definition.
 */
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".moh",
  // Vendored dependency trees are excluded even when committed (Go-style).
  "vendor",
  "third_party",
  "third-party",
  "external",
]);

/**
 * Hard sensitive-file denylist (root-relative or suffix match). These are
 * never mapped, never hashed into the projection, and never rescuable by a
 * `!` negation in any .gitignore — secrets are metadata-free by policy.
 */
const SENSITIVE_EXACT = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  ".pypirc",
  "credentials.json",
  "secrets.json",
]);
const SENSITIVE_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".secrets",
];
const SENSITIVE_PREFIXES = ["id_rsa", "id_ed25519", "id_ecdsa", ".env."];

/** Binary formats are never extracted; content sniffing would be wasted work. */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".bmp", ".tiff",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar",
  ".wasm", ".node", ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".flac", ".ogg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".sqlite", ".db", ".parquet", ".pickle", ".pyc", ".class",
]);

/** Generated-source name patterns excluded even when not gitignored. */
const GENERATED_SUFFIXES = [".min.js", ".min.css", ".map", ".d.ts", ".lock"];
const GENERATED_EXACT = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "Cargo.lock", "poetry.lock", "Gemfile.lock"]);

/** One gitignore pattern compiled for fast matching. */
interface IgnorePattern {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

/**
 * Discover candidate files under `root`, deterministic in order (sorted per
 * directory), with symlinks resolved only when their real path stays inside
 * the root. Never throws: an unreadable entry is skipped, not fatal.
 */
export function discoverWorkspace(root: string, extraExcludes: string[] = []): string[] {
  const files: string[] = [];
  visit(root, root, [], [], files, new Set<string>(), compilePatterns(extraExcludes));
  return files;
}

function visit(
  absDir: string,
  root: string,
  relParts: string[],
  patternStack: IgnorePattern[][],
  out: string[],
  visitedRealPaths: Set<string>,
  extra: IgnorePattern[] = [],
): void {
  let entries: string[];
  let dirPatterns: IgnorePattern[];
  try {
    entries = readdirSync(absDir).sort();
    dirPatterns = readGitignore(absDir);
  } catch {
    return;
  }
  const patterns = [...patternStack, dirPatterns];
  for (const name of entries) {
    const rel = [...relParts, name].join("/");
    const abs = join(absDir, name);
    // Root-bounded symlink handling: never recurse into a link that leaves
    // the project root (or loops). A link inside the root is followed once.
    let real: string;
    let st: { isDirectory(): boolean; isFile(): boolean; size: number };
    try {
      real = realpathSync(abs);
      const lst = lstatSync(abs);
      if (lst.isSymbolicLink()) {
        if (!isInsideRoot(root, real) || visitedRealPaths.has(real)) continue;
        visitedRealPaths.add(real);
      }
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue;
      if (excluded(rel, true, patterns, extra)) continue;
      visit(abs, root, [...relParts, name], patterns, out, visitedRealPaths, extra);
    } else if (st.isFile()) {
      if (sensitiveDenylist(rel)) continue;
      if (isGenerated(name)) continue;
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
      if (BINARY_EXTENSIONS.has(ext)) continue;
      if (st.size > MPM_MAX_FILE_SIZE) continue;
      if (excluded(rel, false, patterns, extra)) continue;
      out.push(rel);
    }
  }
}

/** Read one directory's .gitignore (empty when absent or unreadable). */
function readGitignore(absDir: string): IgnorePattern[] {
  let raw: string;
  try {
    raw = readFileSync(join(absDir, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const patterns: IgnorePattern[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let pattern = trimmed;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    // A pattern containing an interior slash is anchored to this directory.
    const anchored = pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    patterns.push({ negated, dirOnly, anchored, regex: globToRegex(pattern, anchored) });
  }
  return patterns;
}

function globToRegex(pattern: string, anchored: boolean): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — any number of path segments (or a leading `**/` = anywhere).
        i += 2;
        if (pattern[i] === "/") {
          re += "(?:.*/)?";
          i += 1;
        } else {
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}$`);
}

/**
 * Evaluate the pattern stack (root .gitignore first, nearest last so later
 * lists win). Returns the last decisive verdict; "allow" when nothing
 * matched — git's default is to include.
 */
function matchesAny(rel: string, isDir: boolean, stack: IgnorePattern[][]): "deny" | "allow" {
  let verdict: "deny" | "allow" = "allow";
  for (const list of stack) {
    for (const p of list) {
      if (p.dirOnly && !isDir) continue;
      if (p.regex.test(rel)) verdict = p.negated ? "allow" : "deny";
    }
  }
  return verdict;
}

/** Hard denylist check — checked before gitignore and never negatable. */
function sensitiveDenylist(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (SENSITIVE_EXACT.has(base)) return true;
  if (SENSITIVE_EXACT.has(rel)) return true;
  for (const s of SENSITIVE_SUFFIXES) if (base.endsWith(s)) return true;
  for (const p of SENSITIVE_PREFIXES) if (base.startsWith(p)) return true;
  return false;
}

function isGenerated(base: string): boolean {
  if (GENERATED_EXACT.has(base)) return true;
  for (const s of GENERATED_SUFFIXES) if (base.endsWith(s)) return true;
  return false;
}

function isInsideRoot(root: string, real: string): boolean {
  const rootReal = realpathSync(root);
  return real === rootReal || real.startsWith(rootReal + sep);
}

/** Compile #618 user/project exclusion patterns once per discovery. */
function compilePatterns(patterns: string[]): IgnorePattern[] {
  const out: IgnorePattern[] = [];
  for (const line of patterns) {
    let pattern = line.trim();
    if (!pattern) continue;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    const anchored = pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    // A trailing `/**` also matches the directory itself, so `!dir/**` can
    // re-include a subtree the gitignore pruned (the dir must be entered).
    let re: string;
    if (pattern.endsWith("/**")) {
      re = globToRegex(pattern.slice(0, -3), anchored).source + "(?:/.*)?";
    } else {
      re = globToRegex(pattern, anchored).source;
    }
    out.push({ negated, dirOnly, anchored, regex: new RegExp(`^${re}$`) });
  }
  return out;
}

/**
 * #618 combined verdict for one path: gitignore stack first (nearest list
 * wins), then the extra user/project set. A negated extra pattern that
 * matches re-includes a gitignore drop, but nothing rescues the hard
 * sensitive denylist, generated-output, binary, oversize, or EXCLUDED_DIRS
 * rules — those are checked before this and are final.
 */
function excluded(rel: string, isDir: boolean, stack: IgnorePattern[][], extra: IgnorePattern[]): boolean {
  if (extra.length > 0) {
    const extraVerdict = matchesAny(rel, isDir, [extra]);
    if (extraVerdict === "deny") return true;
    if (extraVerdict === "allow" && extraMatched(rel, isDir, extra)) return false;
  }
  return matchesAny(rel, isDir, stack) === "deny";
}

/** True when any extra pattern (negated or not) actually matched the path. */
function extraMatched(rel: string, isDir: boolean, extra: IgnorePattern[]): boolean {
  for (const p of extra) {
    if (p.dirOnly && !isDir) continue;
    if (p.regex.test(rel)) return true;
  }
  return false;
}
