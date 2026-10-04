/**
 * The extension-deps installer (#1166, ADR-0070): the manifest's
 * `dependencies` object becomes a resolved, digest-pinned, per-extension
 * tree under the moh-owned `extension-deps` root.
 *
 * The contract, in one line: install is download + digest verification +
 * layout — nothing more. No lifecycle script ever runs (a dependency
 * declaring `install`/`postinstall` refuses to install, naming the
 * package); moh writes its own lockfile (`lock.json`) with per-package
 * SRI digests (transitive included) and re-verifies the tree against it
 * at every install — drift is a loud error (the `npm ci` contract);
 * one directory per extension under the root, so one extension cannot
 * resolve another's dependencies and removal is deleting the directory.
 *
 * Pure resolution/layout module: the network/process seam is injected
 * (`DepsIo`, the same `RegistryIo` shape the registry uses), so tests
 * build fake registries and no test ever touches the network.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { RegistryIo } from "./extension-registry";

/** The moh-owned root directory name under the moh home. */
export const EXTENSION_DEPS_DIR = "extension-deps";

/** moh's own lockfile, one per extension directory. */
export const DEPS_LOCK_FILE = "lock.json";

/** The shared tarball cache under the root. No GC: entries are written
 * only after digest verification and read only when their digest matches
 * the lockfile (ADR-0070), so stale entries are inert, never trusted. */
export const DEPS_CACHE_DIR = ".cache";

/** The npm registry metadata endpoint installer reads (override in tests). */
export const NPM_REGISTRY_BASE = "https://registry.npmjs.org";

/**
 * The lockfile: one SRI digest per package, direct and transitive.
 * This is the verifiable artifact — the tree is a function of this
 * file and nothing else (`npm ci`'s contract, ADR-0070).
 */
export interface DepsLockfile {
  lockfileVersion: 1;
  /** The extension manifest's `dependencies` this lock resolves. */
  dependencies: Record<string, string>;
  /** package name@version -> SRI digest + resolved tarball URL. */
  packages: Record<string, { integrity: string; resolved: string }>;
}

/** One resolved node of the dependency tree. */
interface DepNode {
  name: string;
  version: string;
  integrity: string;
  tarballUrl: string;
  dependencies: Record<string, string>;
}

/** The tree-install seam. Same shape as the registry's `RegistryIo`. */
export type DepsIo = RegistryIo;

export type ExactnessCheck = { ok: true } | { ok: false; package: string; spec: string };

/**
 * ADR-0070: exact versions only. A range delegates to the registry a
 * decision the consent already made on specific bytes. The forms moh
 * recognizes as non-exact are the npm range operators, `x`/`X`/`*`
 * wildcards, partial versions, and `latest`/tags — a plain
 * `major.minor.patch` (optionally with a prerelease suffix) is exact.
 */
/** The one spec shape a manifest may declare (ADR-0070). */
export function isExactVersion(spec: string): boolean {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(spec.trim());
}

export function checkExactVersions(dependencies: Record<string, string>): ExactnessCheck {
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== "string" || !isExactVersion(spec)) {
      return { ok: false, package: name, spec: String(spec) };
    }
  }
  return { ok: true };
}

function sriFor(bytes: Uint8Array, scheme: "sha512" | "sha1" = "sha512"): string {
  return `${scheme}-${createHash(scheme).update(bytes).digest("base64")}`;
}

/** One npm packument as the installer reads it. */
export interface DepsPackument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, {
    dist?: { tarball?: string; integrity?: string };
    dependencies?: Record<string, string>;
  }>;
}

/** Per-extension dependency directory under the moh-owned root. */
export function extensionDepsDir(mohHome: string, extensionName: string): string {
  return join(mohHome, EXTENSION_DEPS_DIR, extensionName);
}

/**
 * The offline cache seam (ADR-0070): entries go in only after digest
 * verification and come out only when their digest matches what the
 * lockfile pins — a mismatching entry is invisible, never trusted.
 */
export interface DepsCache {
  get(key: string, integrity: string): Uint8Array | undefined;
  set(key: string, bytes: Uint8Array): void;
}

function cacheFileName(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._@/-]/g, "_")}.tgz`;
}

/** The moh-owned tarball cache under `extension-deps/.cache/`. No GC:
 * a stale entry is simply never matched again, because a read re-verifies
 * the bytes against the integrity the caller asks for. */
export function depsTarballCache(mohHome: string): DepsCache {
  const dir = join(mohHome, EXTENSION_DEPS_DIR, DEPS_CACHE_DIR);
  return {
    get(key, integrity) {
      const file = join(dir, cacheFileName(key));
      if (!existsSync(file)) return undefined;
      try {
        const bytes = readFileSync(file);
        return verifySri(bytes, integrity).ok ? bytes : undefined;
      } catch {
        return undefined;
      }
    },
    set(key, bytes) {
      // An unwritable cache degrades to network installs, never an error.
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, cacheFileName(key)), bytes);
      } catch {
        /* cache is an optimization, not an authority */
      }
    },
  };
}

/**
 * Reads the lockfile of an extension's dependency directory, or null
 * when there is none (the directory does not exist or was never
 * installed).
 */
export function readDepsLockfile(depsDir: string): DepsLockfile | null {
  const file = join(depsDir, DEPS_LOCK_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as DepsLockfile;
    if (parsed.lockfileVersion !== 1 || typeof parsed.packages !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The install request. `cache` is the offline cache: when every package
 * of the resolution is present with a digest that matches the lockfile
 * entry it lands from, the network is never touched (ADR-0070: offline
 * install only with matching cache digests — a cache entry whose digest
 * differs from the lockfile is ignored, never trusted).
 */
export interface InstallDepsOptions {
  /** The manifest's `dependencies` (already exactness-checked). */
  dependencies: Record<string, string>;
  /** The extension's dependency directory (`extensionDepsDir`). */
  depsDir: string;
  io: DepsIo;
  /** Optional offline cache (the moh-owned one is `depsTarballCache`). */
  cache?: DepsCache;
}

export type InstallDepsResult =
  | { ok: true; installed: number; offline: boolean }
  | { ok: false; reason: string; package?: string };

/**
 * Installs the dependency tree for one extension: resolve transitively
 * through npm metadata, refuse any scripted package by name, download
 * (or take from a digest-matching cache), verify every tarball against
 * the SRI digest, extract into the extension's own directory, and write
 * the lockfile last — a failed install never leaves a tree that looks
 * installed.
 */
export async function installExtensionDeps(options: InstallDepsOptions): Promise<InstallDepsResult> {
  const { dependencies, depsDir, io } = options;
  const exact = checkExactVersions(dependencies);
  if (!exact.ok) {
    return { ok: false, package: exact.package, reason: `"${exact.spec}" is not an exact version for ${exact.package} — the manifest declares exact versions only (ADR-0070)` };
  }
  if (Object.keys(dependencies).length === 0) return { ok: true, installed: 0, offline: true };
  // The npm ci contract, half one: an existing tree must still match its
  // own lockfile before anything re-installs — drift is a loud error and
  // the tree is never silently rebuilt over what consent approved.
  if (existsSync(depsDir)) {
    const verdict = verifyDepsTree(depsDir);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
  }

  // The existing lockfile drives re-resolution: a version it pins (and
  // the registry still serves) is reused, so a re-install is the same
  // tree it consented to — a moved `latest` never changes the bytes. An
  // unpinned transitive range resolves against its own packument
  // `latest`; the digest it lands under is pinned in the new lockfile.
  const existingLock = readDepsLockfile(depsDir);

  // Resolve the full transitive closure first — nothing lands until the
  // whole tree resolves, every digest is known, and no package scripts.
  const resolved = new Map<string, DepNode>();
  const bytes = new Map<string, Uint8Array>();
  const queue = Object.entries(dependencies).map(([name, spec]) => ({ name, spec }));
  const seen = new Set<string>();
  let offline = true;
  while (queue.length > 0) {
    const { name, spec } = queue.shift()!;
    const meta = await fetchPackument(io, name);
    if (!meta.ok) return { ok: false, package: name, reason: meta.reason };
    // A direct spec must be exact (checked above); the lockfile's pin
    // wins over re-resolution; otherwise a range resolves to `latest`.
    const pinned = Object.keys(existingLock?.packages ?? {}).find((k) => k === `${name}@${spec}` || (k.startsWith(`${name}@`) && !isExactVersion(spec)));
    const pinnedVersion = pinned?.slice(name.length + 1);
    if (pinnedVersion && !meta.packument.versions?.[pinnedVersion]) {
      // The lockfile pins a version the registry no longer serves: the
      // tree consent approved is unreproducible — refuse, never substitute.
      return { ok: false, package: name, reason: `the lockfile pins ${pinned} and the registry no longer serves it — refusing to substitute a different version (the npm ci contract)` };
    }
    const version = isExactVersion(spec) ? spec : (pinnedVersion ?? meta.packument["dist-tags"]?.latest);
    if (!version) return { ok: false, package: name, reason: `cannot resolve "${spec}" for ${name}: no version on the registry` };
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = meta.packument.versions?.[version];
    if (!row) return { ok: false, package: name, reason: `npm package ${name}@${version} not found` };
    if (!row.dist?.tarball || !row.dist.integrity) {
      return { ok: false, package: name, reason: `npm package ${name}@${version} declares no verifiable tarball or integrity digest` };
    }
    // ADR-0070: a dependency with install lifecycle scripts does not
    // install — loud refusal naming the package. The author bundles.
    const peeked = await fetchVerified(io, options.cache, key, row.dist.tarball, row.dist.integrity, name);
    if (!peeked.ok) return peeked;
    offline = offline && peeked.fromCache;
    const scripts = await readTarballScriptsFromBytes(io, peeked.bytes);
    if (scripts.ok && scripts.hasLifecycle) {
      return { ok: false, package: name, reason: `dependency ${name}@${version} declares install lifecycle scripts (${scripts.names!.join(", ")}) and moh never runs them — the author must bundle the artifact (ADR-0070)` };
    }
    resolved.set(key, { name, version, integrity: row.dist.integrity, tarballUrl: row.dist.tarball, dependencies: row.dependencies ?? {} });
    bytes.set(key, peeked.bytes);
    for (const [depName, depSpec] of Object.entries(row.dependencies ?? {})) {
      queue.push({ name: depName, spec: depSpec });
    }
  }

  // Digest agreement: the registry's digest and an existing lockfile's
  // digest for the same name@version must agree; drift is a loud error,
  // never silently re-pinned (the npm ci contract).
  const lock: DepsLockfile = {
    lockfileVersion: 1,
    dependencies: { ...dependencies },
    packages: {},
  };
  for (const [key, node] of resolved) {
    if (existingLock?.packages[key] && existingLock.packages[key].integrity !== node.integrity) {
      return { ok: false, package: node.name, reason: `integrity drift for ${key}: lockfile says ${existingLock.packages[key].integrity}, registry says ${node.integrity} — refusing (the npm ci contract)` };
    }
    lock.packages[key] = { integrity: node.integrity, resolved: node.tarballUrl };
  }

  // Layout: one directory per extension; the lockfile is written last so
  // a failed install never leaves a tree that claims to be verified.
  const staging = `${depsDir}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const key of resolved.keys()) {
      const node = resolved.get(key)!;
      const tgzBytes = bytes.get(key)!;
      options.cache?.set(key, tgzBytes); // written only after verification
      const pkgDir = join(staging, "node_modules", node.name);
      mkdirSync(pkgDir, { recursive: true });
      await io.extractTgz(tgzBytes, pkgDir);
      // npm tarballs wrap in "package/"; flatten it so the package root
      // is the dependency directory itself.
      const nested = join(pkgDir, "package");
      if (existsSync(nested)) {
        for (const entry of readdirSync(nested)) {
          renameOrMerge(join(nested, entry), join(pkgDir, entry));
        }
        rmSync(nested, { recursive: true, force: true });
      }
    }
    writeFileSync(join(staging, DEPS_LOCK_FILE), JSON.stringify(lock, null, 2), { mode: 0o600 });
    // Atomic swap: the old tree (if any) goes, the verified tree lands.
    rmSync(depsDir, { recursive: true, force: true });
    mkdirSync(resolve(depsDir, ".."), { recursive: true });
    const moved = renameSafe(staging, depsDir);
    if (!moved) {
      // Cross-device rename can fail; fall back to a copy.
      copyDir(staging, depsDir);
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: `layout failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, installed: resolved.size, offline };
}

function renameOrMerge(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyDir(from, to);
    rmSync(from, { recursive: true, force: true });
  }
}

function renameSafe(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else writeFileSync(dst, readFileSync(src));
  }
}

/** One fetched-and-verified tarball, from the cache when the digest
 * matches, from the network otherwise (and then cached). */
async function fetchVerified(
  io: DepsIo,
  cache: DepsCache | undefined,
  key: string,
  tarballUrl: string,
  integrity: string,
  packageName: string,
): Promise<{ ok: true; bytes: Uint8Array; fromCache: boolean } | { ok: false; reason: string; package?: string }> {
  const cached = cache?.get(key, integrity);
  // The cache re-verifies even when the implementation forgets to: the
  // cache is an optimization, never an authority (ADR-0070).
  if (cached && verifySri(cached, integrity).ok) return { ok: true, bytes: cached, fromCache: true };
  const tgz = await io.fetchBytes(tarballUrl);
  if (!tgz.ok) return { ok: false, package: packageName, reason: `tarball download failed for ${key}: ${tgz.message}` };
  const check = verifySri(tgz.body, integrity);
  if (!check.ok) {
    return { ok: false, package: packageName, reason: `checksum mismatch for ${key}: expected ${check.expected}, got ${check.actual}` };
  }
  return { ok: true, bytes: tgz.body, fromCache: false };
}

/** The package name half of a lockfile key (`name@version`). */
function lockKeyPackage(key: string): string {
  return key.slice(0, key.lastIndexOf("@"));
}

/** Link the verified tree before importing the extension. Never resolve a
 * package before layout: Bun can cache the missing node_modules directory. */
export function linkDepsTree(depsDir: string, extensionDir: string): { ok: true } | { ok: false; message: string } {
  const target = resolve(depsDir, "node_modules");
  const link = join(extensionDir, "node_modules");
  try {
    try {
      if (readlinkSync(link) === target) return { ok: true };
      return { ok: false, message: `refusing to replace an unrelated dependency link: ${link}` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    symlinkSync(target, link, "dir");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `cannot link dependency tree: ${String(err)}` };
  }
}

function verifySri(bytes: Uint8Array, integrity: string): { ok: true } | { ok: false; expected: string; actual: string } {
  const [scheme, b64] = integrity.split("-", 2);
  if (scheme !== "sha512" && scheme !== "sha1") {
    return { ok: false, expected: integrity, actual: `unsupported integrity scheme "${scheme ?? ""}"` };
  }
  const actual = `${scheme}-${createHash(scheme).update(bytes).digest("base64")}`;
  return actual === integrity ? { ok: true } : { ok: false, expected: integrity, actual };
}

async function fetchPackument(io: DepsIo, name: string): Promise<{ ok: true; packument: DepsPackument } | { ok: false; reason: string }> {
  const encoded = name.replace("/", "%2f");
  const meta = await io.fetchText(`${NPM_REGISTRY_BASE}/${encoded}`);
  if (!meta.ok) return { ok: false, reason: `npm registry lookup failed for ${name}: ${meta.message}` };
  try {
    return { ok: true, packument: JSON.parse(meta.body) as DepsPackument };
  } catch (err) {
    return { ok: false, reason: `npm registry returned invalid JSON for ${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Peeks an extracted-at-install tarball's `package.json` in a throwaway
 * directory and reports whether the package declares install lifecycle
 * scripts. Extraction never executes anything — it lays down bytes.
 */
async function readTarballScriptsFromBytes(
  io: DepsIo,
  tarball: Uint8Array,
): Promise<{ ok: true; hasLifecycle: boolean; names?: string[] } | { ok: false; reason: string }> {
  const peek = `${depsPeekRoot()}/moh-deps-peek-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(peek, { recursive: true });
    await io.extractTgz(tarball, peek);
    const nested = join(peek, "package");
    const root = existsSync(nested) ? nested : peek;
    const pkgFile = join(root, "package.json");
    if (!existsSync(pkgFile)) return { ok: true, hasLifecycle: false };
    const parsed = JSON.parse(readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    const names = ["preinstall", "install", "postinstall"].filter((s) => typeof scripts[s] === "string" && scripts[s].length > 0);
    return { ok: true, hasLifecycle: names.length > 0, names: names.length ? names : undefined };
  } catch (err) {
    return { ok: false, reason: `could not inspect tarball for lifecycle scripts: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    rmSync(peek, { recursive: true, force: true });
  }
}

function depsPeekRoot(): string {
  return process.env.TMPDIR || "/tmp";
}

/** The tree-verify half of the npm ci contract: the installed tree on
 * disk must still match its own lockfile — package dirs present, no
 * extras. Used at every install and by verify on demand. */
export function verifyDepsTree(depsDir: string): { ok: true } | { ok: false; reason: string } {
  const lock = readDepsLockfile(depsDir);
  if (!lock) return { ok: false, reason: `no ${DEPS_LOCK_FILE} in ${depsDir} — the tree is not a verified install` };
  const modulesDir = join(depsDir, "node_modules");
  if (!existsSync(modulesDir)) return { ok: false, reason: `no node_modules under ${depsDir} — the tree is missing` };
  for (const [key] of Object.entries(lock.packages)) {
    const pkgDir = join(modulesDir, lockKeyPackage(key));
    if (!existsSync(pkgDir)) return { ok: false, reason: `drift: ${key} is in the lockfile but missing from the tree` };
  }
  const lockedNames = new Set(Object.keys(lock.packages).map(lockKeyPackage));
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // A scoped root (@scope) is a directory of packages, not a package.
    const leaves = entry.name.startsWith("@")
      ? readdirSync(join(modulesDir, entry.name), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${entry.name}/${e.name}`)
      : [entry.name];
    for (const name of leaves) {
      if (!lockedNames.has(name)) return { ok: false, reason: `drift: ${name} is in the tree but not in the lockfile` };
    }
  }
  return { ok: true };
}

/**
 * ADR-0070 removal: deleting the extension's dependency directory is
 * the whole of removal — the root holds nothing else, there is no
 * shared store and no GC.
 */
export function removeExtensionDeps(mohHome: string, extensionName: string): { ok: true; removed?: string } | { ok: false; reason: string } {
  const dir = extensionDepsDir(mohHome, extensionName);
  if (!existsSync(dir)) return { ok: true };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, removed: dir };
  } catch (err) {
    return { ok: false, reason: `cannot remove ${dir}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
