/**
 * The extension registry (#1128, ADR-0061): `moh extension add` installs
 * from exactly two immutable sources — npm scoped packages and GitHub
 * releases (repo + tag) — performing static checks only. Package code is
 * never executed: the manifest is read as bytes, the checksum is verified
 * against the source's own digest, and an unknown capability slot warns
 * without refusing (the slot vocabulary grows; the load-time consent
 * still decides). Installation never authorizes.
 *
 * `list` and `remove` share this module's catalog seam: the installed
 * packages are the directories under the source roots (user dotdir and
 * project), each carrying its `moh.extension.json`.
 *
 * Pure dependency seam: everything that touches the network or spawns a
 * process is injected (`RegistryIo`), so tests build fake sources with no
 * network at all.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MANIFEST_FILE, readExtensionManifest, type ExtensionManifest } from "./extension-manifest";
import { PATH_SCOPE_PREFIX, HOST_SCOPE_PREFIX } from "./host-scope";
import { CREDENTIAL_SCOPE_PREFIX } from "./credential-scope";
import { TOOL_SCOPE_PREFIX, CONTRIBUTE_TOOL_SCOPE_PREFIX } from "./tool-scope";

/** npm integrity digests (`sha512-...`) we can verify. */
export type IntegrityAlgorithm = "sha512" | "sha1";

export const EXTENSION_REGISTRY_USAGE_LINES = {
  npm: "@scope/name[@version] — an npm scoped package",
  github: "github:owner/repo[@tag] — a GitHub release (repo + tag)",
} as const;

export type ExtensionRef =
  | { source: "npm"; package: string; version?: string }
  | { source: "github"; owner: string; repo: string; tag?: string };

/**
 * Parses the two immutable source references. Anything else — a bare
 * name, an https URL, a tarball path — is refused with the
 * immutable-sources reason.
 */
export function parseExtensionRef(input: string): { ok: true; ref: ExtensionRef } | { ok: false; reason: string } {
  const spec = input.trim();
  if (!spec) return { ok: false, reason: "empty reference" };
  if (/^https?:\/\//i.test(spec) || /\.(tgz|tar\.gz|zip)$/i.test(spec)) {
    return {
      ok: false,
      reason: `raw URLs and tarballs are not installed: extensions come from immutable sources only (${EXTENSION_REGISTRY_USAGE_LINES.npm}; ${EXTENSION_REGISTRY_USAGE_LINES.github}) — a fixed, checksum-verified artifact the consent's SHA-256 binding stays meaningful against`,
    };
  }
  if (spec.startsWith("github:")) {
    const body = spec.slice("github:".length);
    const at = body.lastIndexOf("@");
    const repoPart = at > 0 ? body.slice(0, at) : body;
    const tag = at > 0 ? body.slice(at + 1) : undefined;
    const [owner, repo] = repoPart.split("/");
    if (!owner || !repo || repoPart.includes("@") || repoPart.split("/").length !== 2) {
      return { ok: false, reason: `expected github:owner/repo[@tag], got "${spec}"` };
    }
    return { ok: true, ref: { source: "github", owner, repo, ...(tag ? { tag } : {}) } };
  }
  // npm scoped: @scope/name[@version]. The scope's @ is part of the name,
  // so the version separator is the last @ after the first character.
  if (spec.startsWith("@")) {
    const at = spec.indexOf("@", 1);
    if (at > 0) {
      const pkg = spec.slice(0, at);
      const version = spec.slice(at + 1);
      if (!version) return { ok: false, reason: `expected a version after "@", got "${spec}"` };
      return { ok: true, ref: { source: "npm", package: pkg, version } };
    }
    if (spec.includes("/") && !spec.endsWith("/")) {
      return { ok: true, ref: { source: "npm", package: spec } };
    }
    return { ok: false, reason: `expected npm scoped package @scope/name[@version], got "${spec}"` };
  }
  return {
    ok: false,
    reason: `"${spec}" is not an immutable source: use ${EXTENSION_REGISTRY_USAGE_LINES.npm} or ${EXTENSION_REGISTRY_USAGE_LINES.github}`,
  };
}

/** The network/process seam. The CLI injects the real one; tests fake it. */
export interface RegistryIo {
  fetchText(url: string): Promise<{ ok: true; body: string } | { ok: false; status?: number; message: string }>;
  fetchBytes(url: string): Promise<{ ok: true; body: Uint8Array } | { ok: false; status?: number; message: string }>;
  /** Decompress + untar a .tgz into `dir` (real impl: `tar -xzf` via Bun). */
  extractTgz(tgz: Uint8Array, dir: string): Promise<void>;
}

/**
 * The real registry IO: fetch for text/bytes, system tar for extraction.
 * Shared by `moh extension add` (CLI) and the ADR-0070 dependency
 * installer (runtime); tests always inject a fake instead.
 */
export function realRegistryIo(): RegistryIo {
  return {
    async fetchText(url: string) {
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status} for ${url}` };
        return { ok: true, body: await res.text() };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    async fetchBytes(url: string) {
      try {
        const res = await fetch(url);
        if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status} for ${url}` };
        return { ok: true, body: new Uint8Array(await res.arrayBuffer()) };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    async extractTgz(tgz: Uint8Array, dir: string) {
      const proc = Bun.spawn(["tar", "-xzf", "-", "-C", dir], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      });
      proc.stdin.write(tgz);
      proc.stdin.end();
      const code = await proc.exited;
      if (code !== 0) throw new Error(`tar extraction failed (exit ${code}): ${await new Response(proc.stderr).text()}`);
    },
  };
}

/** One installed extension as `list` reports it. */
export interface InstalledExtension {
  name: string;
  version: string;
  /** Where the package directory lives. */
  path: string;
  /** The entry file's name inside the package (the path `moh.json` or the dotdir loader names). */
  entry: readonly string[];
  capabilities: readonly string[];
  /** npm specs the package declares as its dependencies (noted, never installed here). */
  dependencies: readonly string[];
  scope: "user" | "project";
  /** Duplicate identity elsewhere: the ignored copy's path (ADR-0061). */
  ignoredDuplicates?: readonly string[];
}

export interface InstallOptions {
  ref: ExtensionRef;
  /** Destination root: the user dotdir (`<home>/.moh`) or the project (`cwd`). */
  destRoot: string;
  io: RegistryIo;
}

export type InstallResult =
  | { ok: true; name: string; version: string; dir: string; warnings: string[]; notes: string[] }
  | { ok: false; reason: string; expected?: string; actual?: string };

/** npm registry metadata `dist.integrity` (the shape `packument` ships). */
export interface NpmPackument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, { dist?: { tarball?: string; integrity?: string }; dependencies?: Record<string, string> }>;
}

/** A GitHub release (the REST shape subset we read). */
export interface GithubRelease {
  tag_name?: string;
  assets?: readonly { name?: string; browser_download_url?: string }[];
  tarball_url?: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Verifies an npm `dist.integrity` string (`sha512-base64` / `sha1-base64`). */
export function verifyIntegrity(tgz: Uint8Array, integrity: string): { ok: true } | { ok: false; expected: string; actual: string } {
  const [scheme, b64] = integrity.split("-", 2);
  if (scheme !== "sha512" && scheme !== "sha1") {
    return { ok: false, expected: integrity, actual: `unsupported integrity scheme "${scheme ?? ""}"` };
  }
  const actual = createHash(scheme).update(tgz).digest("base64");
  return actual === b64 ? { ok: true } : { ok: false, expected: `${scheme}-${b64}`, actual: `${scheme}-${actual}` };
}

/** Static manifest checks an install (or any directory) must pass. */
function checkManifest(pkgDir: string): { manifest: ExtensionManifest; warnings: string[]; notes: string[] } | { reason: string } {
  const entries = readdirSync(pkgDir);
  const moduleEntry = entries.find((name) => /\.(ts|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts") && name !== MANIFEST_FILE);
  if (!moduleEntry) return { reason: `no entry module found beside ${MANIFEST_FILE} in the package root` };
  const result = readExtensionManifest(join(pkgDir, moduleEntry));
  if (!result.ok) return { reason: result.message };
  const warnings: string[] = [];
  const notes: string[] = [];
  for (const capability of result.manifest.capabilities) {
    if (!isKnownCapability(capability)) {
      warnings.push(`unknown capability slot "${capability}" — the load-time consent still decides what it grants`);
    }
  }
  const deps = readNpmDependencies(pkgDir);
  if (deps.length) notes.push(`declares npm dependencies: ${deps.join(", ")} — not installed by moh; nothing is executed here, and the load-time consent governs the code`);
  return { manifest: result.manifest, warnings, notes };
}

/** The capability slots the shipped host knows (ADR-0053/0061/0062). Unknown ones warn. */
export const KNOWN_CAPABILITY_SLOTS: readonly string[] = [
  "observe",
  "veto",
  "ask",
  "spawn-subagent",
  "orchestrate",
  "contribute-commands",
  "contribute-panels",
  "contribute-overlays",
];

/**
 * ADR-0071: a scope prefix becomes a known slot only when its phase
 * ships. Phase F1 ships `path:<glob>` (ADR-0065) — any glob it carries is
 * known; later prefixes are still unknown-slot warnings.
 */
export function isKnownCapability(capability: string): boolean {
  return (
    KNOWN_CAPABILITY_SLOTS.includes(capability) ||
    capability.startsWith(PATH_SCOPE_PREFIX) ||
    capability.startsWith(HOST_SCOPE_PREFIX) ||
    capability.startsWith(CREDENTIAL_SCOPE_PREFIX) ||
    // ADR-0071 phase F3a ships the tool scopes (ADR-0067).
    capability.startsWith(TOOL_SCOPE_PREFIX) ||
    capability.startsWith(CONTRIBUTE_TOOL_SCOPE_PREFIX)
  );
}

function readNpmDependencies(pkgDir: string): string[] {
  const file = join(pkgDir, "package.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readTextSync(file)) as { dependencies?: Record<string, string> };
    return Object.keys(parsed.dependencies ?? {});
  } catch {
    return [];
  }
}

function readTextSync(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * Installs one extension package: resolve → download → verify checksum →
 * extract → static manifest checks. The tarball bytes are the only thing
 * that ever gets written; nothing is executed, not even `npm install`.
 */
export async function installExtension(options: InstallOptions): Promise<InstallResult> {
  const { ref, io, destRoot } = options;
  if (ref.source === "npm") {
    const version = ref.version ?? "latest";
    const encoded = ref.package.replace("/", "%2f");
    const meta = await io.fetchText(`https://registry.npmjs.org/${encoded}`);
    if (!meta.ok) return { ok: false, reason: `npm registry lookup failed: ${meta.message}` };
    let packument: NpmPackument;
    try {
      packument = JSON.parse(meta.body) as NpmPackument;
    } catch (err) {
      return { ok: false, reason: `npm registry returned invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const resolved = version === "latest" ? packument["dist-tags"]?.latest : version;
    const row = resolved ? packument.versions?.[resolved] : undefined;
    if (!resolved || !row) {
      return { ok: false, reason: `npm package ${ref.package}@${version} not found` };
    }
    if (!row.dist?.tarball) return { ok: false, reason: `npm package ${ref.package}@${resolved} declares no tarball` };
    const integrity = row.dist.integrity;
    if (!integrity) return { ok: false, reason: `npm package ${ref.package}@${resolved} declares no integrity digest — refusing an unverifiable install` };
    const tgz = await io.fetchBytes(row.dist.tarball);
    if (!tgz.ok) return { ok: false, reason: `tarball download failed: ${tgz.message}` };
    const check = verifyIntegrity(tgz.body, integrity);
    if (!check.ok) return { ok: false, reason: "checksum mismatch", expected: check.expected, actual: check.actual };
    return extractAndCheck({ tgz: tgz.body, destRoot, io, label: `${ref.package}@${resolved}`, hash: sha256(tgz.body) });
  }
  // github: release. The checksum is the release's own SHA-256 asset for
  // the source tarball (`<name>.sha256`), or — absent — the release
  // tarball's digest recorded at fetch time is refused (no digest, no
  // install): an unverifiable artifact is never installed.
  const tagPart = ref.tag ? `tags/${ref.tag}` : "latest";
  const release = await io.fetchText(`https://api.github.com/repos/${ref.owner}/${ref.repo}/releases/${tagPart}`);
  if (!release.ok) return { ok: false, reason: `GitHub release lookup failed: ${release.message}` };
  let parsed: GithubRelease;
  try {
    parsed = JSON.parse(release.body) as GithubRelease;
  } catch (err) {
    return { ok: false, reason: `GitHub release returned invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const assets = parsed.assets ?? [];
  const sourceAsset = assets.find((a) => /\.(tar\.gz|tgz)$/.test(a.name ?? ""));
  const digestAsset = assets.find((a) => /\.sha256$/.test(a.name ?? ""));
  if (!sourceAsset?.browser_download_url) {
    return { ok: false, reason: `GitHub release ${parsed.tag_name ?? tagPart} of ${ref.owner}/${ref.repo} publishes no source tarball asset — refusing an unverifiable install` };
  }
  if (!digestAsset?.browser_download_url) {
    return { ok: false, reason: `GitHub release ${parsed.tag_name ?? tagPart} publishes no .sha256 digest asset — refusing an unverifiable install` };
  }
  const [tgz, digestFile] = await Promise.all([
    io.fetchBytes(sourceAsset.browser_download_url),
    io.fetchText(digestAsset.browser_download_url),
  ]);
  if (!tgz.ok) return { ok: false, reason: `tarball download failed: ${tgz.message}` };
  if (!digestFile.ok) return { ok: false, reason: `digest download failed: ${digestFile.message}` };
  const expected = digestFile.body.trim().split(/\s+/)[0]?.toLowerCase();
  const actual = sha256(tgz.body);
  if (!expected || expected !== actual) {
    return { ok: false, reason: "checksum mismatch", expected: digestFile.body.trim(), actual };
  }
  return extractAndCheck({ tgz: tgz.body, destRoot, io, label: `github:${ref.owner}/${ref.repo}@${parsed.tag_name ?? tagPart}`, hash: actual });
}

async function extractAndCheck(input: {
  tgz: Uint8Array;
  destRoot: string;
  io: RegistryIo;
  label: string;
  hash: string;
}): Promise<InstallResult> {
  const staging = join(input.destRoot, ".moh-staging");
  mkdirSync(input.destRoot, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    await input.io.extractTgz(input.tgz, staging);
    // npm tarballs wrap everything in "package/"; a GitHub archive may not.
    const nested = join(staging, "package");
    const pkgDir = existsSync(nested) ? nested : staging;
    const checked = checkManifest(pkgDir);
    if ("reason" in checked) return { ok: false, reason: checked.reason };
    const finalDir = join(input.destRoot, checked.manifest.name);
    if (existsSync(finalDir)) {
      return { ok: false, reason: `${checked.manifest.name}@${checked.manifest.version} is already installed at ${finalDir} — remove it first (moh extension remove ${checked.manifest.name}) to replace it: overwriting would silently change bytes an earlier consent signed` };
    }
    renameSync(pkgDir, finalDir);
    rmSync(staging, { recursive: true, force: true });
    return {
      ok: true,
      name: checked.manifest.name,
      version: checked.manifest.version,
      dir: finalDir,
      warnings: checked.warnings,
      notes: [...checked.notes, `installed from ${input.label} (source sha256 ${input.hash.slice(0, 12)}…) — installation never authorizes; the load-time consent decides`],
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Where installed packages live, per scope. */
export function registryRoots(options: { mohHome: string; cwd: string }): { scope: "user" | "project"; root: string }[] {
  return [
    { scope: "user", root: join(options.mohHome, "extensions") },
    { scope: "project", root: resolve(join(options.cwd, "extensions")) },
  ];
}

/** The installed package directories under one root, sorted; hidden dirs (the staging dir) are never packages. */
function installedPackageDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // an unreadable root is "nothing installed", never a listing error
  }
}

/**
 * Lists the installed extensions across both roots, reading only
 * manifests. The same package identity (manifest `name`) installed in
 * both scopes resolves by the discovery precedence — project wins over
 * the user dotdir — and the ignored copy is reported, not an error.
 */
export function listInstalledExtensions(options: { mohHome: string; cwd: string }): InstalledExtension[] {
  const byName = new Map<string, InstalledExtension>();
  const duplicates = new Map<string, string[]>();
  for (const { scope, root } of registryRoots(options)) {
    if (!existsSync(root)) continue;
    for (const dir of installedPackageDirs(root)) {
      const path = join(root, dir);
      const checked = checkManifest(path);
      if ("reason" in checked) continue; // a broken dir is not a listing error
      const existing = byName.get(checked.manifest.name);
      if (existing) {
        // Discovery precedence: the project copy wins over the dotdir.
        const winner = scopeRank(existing.scope) <= scopeRank(scope) ? existing : { ...toInstalled(checked.manifest, path, scope), ignoredDuplicates: existing.ignoredDuplicates };
        const loser = scopeRank(existing.scope) <= scopeRank(scope) ? toInstalled(checked.manifest, path, scope) : existing;
        const ignored = [...duplicates.get(checked.manifest.name) ?? [], loser.path];
        winner.ignoredDuplicates = ignored;
        duplicates.set(checked.manifest.name, ignored);
        byName.set(checked.manifest.name, winner);
      } else {
        byName.set(checked.manifest.name, toInstalled(checked.manifest, path, scope));
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scopeRank(scope: "user" | "project"): number {
  return scope === "project" ? 0 : 1;
}

function toInstalled(manifest: ExtensionManifest, path: string, scope: "user" | "project"): InstalledExtension {
  const deps = readNpmDependencies(path);
  return {
    name: manifest.name,
    version: manifest.version,
    path,
    entry: manifest.entry,
    capabilities: manifest.capabilities,
    dependencies: deps,
    scope,
  };
}

/** Removes one installed package by manifest name, project scope first. */
export function removeInstalledExtension(name: string, options: { mohHome: string; cwd: string }): { ok: true; path: string; scope: "user" | "project" } | { ok: false; reason: string } {
  for (const { scope, root } of [...registryRoots(options)].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope))) {
    if (!existsSync(root)) continue;
    for (const dir of installedPackageDirs(root)) {
      const path = join(root, dir);
      const checked = checkManifest(path);
      if ("reason" in checked) continue;
      if (checked.manifest.name === name) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch (err) {
          return { ok: false, reason: `cannot remove ${path}: ${err instanceof Error ? err.message : String(err)}` };
        }
        return { ok: true, path, scope };
      }
    }
  }
  return { ok: false, reason: `no installed extension named "${name}"` };
}
