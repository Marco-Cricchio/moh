/**
 * Workflow mode (#11/#36): the optional Matt Pocock-style workflow.
 *
 * First-party skills are bundled in the moh package (`assets/skills/`)
 * and copied into `~/.moh/skills/` where the ordinary skills loader
 * finds them — they load like any skill and only differ in ownership:
 * moh may upgrade them, but only when the local copy is unmodified
 * (content-hash check) and only after a diff has been shown and
 * consented to. `minMohVersion` in a skill's frontmatter gates skills
 * that need a newer moh.
 *
 * The upstream channel (opt-out via the user config) is polled in the
 * background; failures are silent — it never blocks startup.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseSkillFrontmatter, FIRST_PARTY_MANIFEST, firstPartySkillNames } from "./skills";

/** The moh version skills compare their `minMohVersion` against. */
export const MOH_VERSION = "0.1.0";

/** Default upstream index for first-party skills (opt-out, background). */
export const DEFAULT_UPSTREAM_URL = "https://raw.githubusercontent.com/moh-workflow/skills/main/index.json";

/** Where the bundled first-party skills ship inside the package. */
export function defaultBundleDir(): string {
  return join(import.meta.dir, "..", "assets", "skills");
}

/**
 * Embedded skills registry set by the compiled binary's generated entry
 * (scripts/build.ts): relative path within the skills bundle → absolute path
 * of the extracted embedded asset. Absent in dev runs (repo checkout).
 */
export const EMBEDDED_SKILLS_KEY = "__MOH_EMBEDDED_SKILLS__";

function embeddedRegistry(): Record<string, string> | null {
  const reg = (globalThis as Record<string, unknown>)[EMBEDDED_SKILLS_KEY];
  return typeof reg === "object" && reg !== null ? (reg as Record<string, string>) : null;
}

/**
 * Reads first-party skills from the embedded-assets registry (binary run,
 * #267). Keys are `<skill>/<file>` paths; values are absolute paths of the
 * files Bun extracted from the binary. Grouped and parsed exactly like the
 * on-disk bundle.
 */
export function embeddedSkillSources(registry: Record<string, string>): FirstPartySkillSource[] {
  const bySkill = new Map<string, Map<string, string>>();
  for (const [rel, abs] of Object.entries(registry)) {
    const slash = rel.indexOf("/");
    if (slash <= 0) continue;
    const name = rel.slice(0, slash);
    const file = rel.slice(slash + 1);
    if (!bySkill.has(name)) bySkill.set(name, new Map());
    bySkill.get(name)!.set(file, abs);
  }
  const sources: FirstPartySkillSource[] = [];
  for (const [name, files] of bySkill) {
    const skillAbs = files.get("SKILL.md");
    if (!skillAbs) continue;
    const raw = readFileSync(skillAbs, "utf8");
    const parsed = parseSkillFrontmatter(raw);
    if (!parsed) continue;
    const contents: Record<string, string> = { "SKILL.md": raw };
    for (const [file, abs] of files) {
      if (file !== "SKILL.md") contents[file] = readFileSync(abs, "utf8");
    }
    const minMohVersion = /^minMohVersion:\s?(.+)$/m.exec(raw)?.[1]?.trim();
    sources.push({ ...parsed, ...(minMohVersion ? { minMohVersion } : {}), files: contents });
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The skills the running moh ships with: the binary's embedded assets when
 * the registry is present (invariant 2: no repo-relative reads), otherwise
 * the on-disk bundle (repo-checkout dev run, unchanged).
 */
export function bundledSkillSources(): FirstPartySkillSource[] {
  const registry = embeddedRegistry();
  if (registry) return embeddedSkillSources(registry);
  return firstPartySkillSources();
}

/** One first-party skill as bundled (or fetched from upstream). */
export interface FirstPartySkillSource {
  name: string;
  description: string;
  /** Minimum moh version required by this skill (frontmatter). */
  minMohVersion?: string;
  /** Relative path → file content. Always includes `SKILL.md`. */
  files: Record<string, string>;
}

/** Reads the bundled first-party skills from `bundleDir` (tests inject). */
export function firstPartySkillSources(bundleDir: string = defaultBundleDir()): FirstPartySkillSource[] {
  if (!existsSync(bundleDir)) return [];
  const sources: FirstPartySkillSource[] = [];
  for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(bundleDir, entry.name);
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const raw = readFileSync(skillFile, "utf8");
    const parsed = parseSkillFrontmatter(raw);
    if (!parsed) continue;
    const files: Record<string, string> = { "SKILL.md": raw };
    for (const other of readdirSync(dir, { withFileTypes: true })) {
      if (other.isFile() && other.name !== "SKILL.md") files[other.name] = readFileSync(join(dir, other.name), "utf8");
    }
    const minMohVersion = /^minMohVersion:\s?(.+)$/m.exec(raw)?.[1]?.trim();
    sources.push({ ...parsed, ...(minMohVersion ? { minMohVersion } : {}), files });
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

/** Content hash of a skill's files (path-sorted, stable). */
export function hashSkillFiles(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) hash.update(path).update("\0").update(files[path]!).update("\0");
  return hash.digest("hex").slice(0, 16);
}

/** Hash of the files currently installed for `name` under `<mohHome>/skills`. */
function installedHash(mohHome: string, name: string): string | null {
  const dir = join(mohHome, "skills", name);
  if (!existsSync(join(dir, "SKILL.md"))) return null;
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) files[entry.name] = readFileSync(join(dir, entry.name), "utf8");
  }
  return hashSkillFiles(files);
}

/** The manifest tracking moh-owned skill copies (hash at install time). */
export interface FirstPartyManifest {
  skills: Record<string, { hash: string; installedAt: string }>;
}

/** Reads `~/.moh/skills/.moh-first-party.json`; missing → empty manifest. */
export function loadFirstPartyManifest(mohHome: string): FirstPartyManifest {
  try {
    const raw = JSON.parse(readFileSync(join(mohHome, "skills", FIRST_PARTY_MANIFEST), "utf8"));
    if (typeof raw === "object" && raw !== null && typeof (raw as any).skills === "object") {
      return raw as FirstPartyManifest;
    }
  } catch {
    // missing or invalid: empty
  }
  return { skills: {} };
}

function saveFirstPartyManifest(mohHome: string, manifest: FirstPartyManifest): void {  const file = join(mohHome, "skills", FIRST_PARTY_MANIFEST);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Loose semver compare: returns true when `need <= have`. */
export function versionSatisfied(need: string, have: string): boolean {
  const parse = (v: string) => v.split(".").map((p) => parseInt(p, 10) || 0);
  const [a, b] = [parse(need), parse(have)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return true;
}

/** Reads one bundled first-party skill by name (the /ask-moh router).
 * Returns null when the skill is not in the bundle. */
export function readBundledSkill(
  name: string,
  bundleDir?: string,
): FirstPartySkillSource | null {
  return (bundleDir ? firstPartySkillSources(bundleDir) : bundledSkillSources()).find((s) => s.name === name) ?? null;
}

export interface SkillInstallReport {
  /** Newly copied skills. */
  installed: string[];
  /** Unmodified copies refreshed to a newer bundled version. */
  updated: string[];
  /** Already current at the bundled version. */
  unchanged: string[];
  /** Local copy modified by the user (hash mismatch) — left alone. */
  skippedModified: string[];
  /** Requires a newer moh than MOH_VERSION — not installed. */
  skippedMinVersion: string[];
  /** Stale moh-owned skills no longer bundled, unmodified — removed (#74). */
  pruned: string[];
}

export interface InstallFirstPartySkillsOptions {
  /** User-level moh dir (`~/.moh`). */
  mohHome: string;
  /** Bundled sources override (tests). Default: the shipped assets. */
  sources?: FirstPartySkillSource[];
}

/**
 * Copies the bundled first-party skills into `~/.moh/skills/` and records
 * their hashes in the manifest. Never overwrites a user-modified copy;
 * min-version-gated skills are skipped entirely.
 */
export function installFirstPartySkills(options: InstallFirstPartySkillsOptions): SkillInstallReport {
  const sources = options.sources ?? bundledSkillSources();
  const manifest = loadFirstPartyManifest(options.mohHome);
  const report: SkillInstallReport = {
    installed: [],
    updated: [],
    unchanged: [],
    skippedModified: [],
    skippedMinVersion: [],
    pruned: [],
  };
  // Prune stale moh-owned skills (#74): bundle entries no longer shipped.
  // Unmodified copies are deleted; user-modified ones stay on disk but lose
  // moh ownership (they become plain user skills).
  for (const name of Object.keys(manifest.skills)) {
    if (sources.some((s) => s.name === name)) continue;
    const recorded = manifest.skills[name]!.hash;
    const current = installedHash(options.mohHome, name);
    if (current !== null && current === recorded) {
      rmSync(join(options.mohHome, "skills", name), { recursive: true, force: true });
      report.pruned.push(name);
    } else if (current !== null) {
      report.skippedModified.push(name);
    }
    delete manifest.skills[name];
  }
  for (const source of sources) {
    if (source.minMohVersion && !versionSatisfied(source.minMohVersion, MOH_VERSION)) {
      report.skippedMinVersion.push(source.name);
      continue;
    }
    const targetHash = hashSkillFiles(source.files);
    const recorded = manifest.skills[source.name]?.hash;
    const current = installedHash(options.mohHome, source.name);
    if (current === null) {
      report.installed.push(source.name);
    } else if (current !== recorded) {
      // user-modified: leave the copy alone
      report.skippedModified.push(source.name);
      continue;
    } else if (current === targetHash) {
      report.unchanged.push(source.name);
      continue;
    } else {
      report.updated.push(source.name);
    }
    const dir = join(options.mohHome, "skills", source.name);
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of Object.entries(source.files)) {
      writeFileSync(join(dir, path), content);
    }
    manifest.skills[source.name] = { hash: targetHash, installedAt: new Date().toISOString() };
  }
  saveFirstPartyManifest(options.mohHome, manifest);
  return report;
}

/** One skill with a newer upstream version available. */
export interface UpstreamUpdate {
  name: string;
  /** Hash of the (unmodified) local copy. */
  currentHash: string;
  /** Hash of the upstream files. */
  upstreamHash: string;
  /** Upstream files; used by `applyUpstreamUpdates`. */
  files: Record<string, string>;
  minMohVersion?: string;
}

export interface UpstreamIndex {
  skills: { name: string; files: Record<string, string>; minMohVersion?: string }[];
}

export interface CheckUpstreamOptions {
  mohHome: string;
  /** Upstream index URL. Default: DEFAULT_UPSTREAM_URL. */
  upstream?: string;
  /** Fetch implementation (tests). Default: global fetch. */
  fetchImpl?: (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;
  /** Timeout applied to the default fetch. Default: 5s. */
  timeoutMs?: number;
}

/**
 * Background update check (#36): fetches the upstream index and returns
 * the updates applicable to *unmodified* local copies. Modified skills
 * are skipped by the hash check; min-version-gated ones are skipped.
 * Any failure yields an empty list — the check is fail-silent.
 */
export async function checkUpstreamUpdates(options: CheckUpstreamOptions): Promise<UpstreamUpdate[]> {
  const fetchImpl =
    options.fetchImpl ??
    (async (url: string) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 5_000);
      try {
        return await globalThis.fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    });
  let index: UpstreamIndex;
  try {
    const res = await fetchImpl(options.upstream ?? DEFAULT_UPSTREAM_URL);
    if (!res.ok) return [];
    index = JSON.parse(await res.text());
  } catch {
    return [];
  }
  if (!index || !Array.isArray(index.skills)) return [];
  const manifest = loadFirstPartyManifest(options.mohHome);
  const updates: UpstreamUpdate[] = [];
  for (const skill of index.skills) {
    if (typeof skill?.name !== "string" || !skill.files) continue;
    if (skill.minMohVersion && !versionSatisfied(skill.minMohVersion, MOH_VERSION)) continue;
    const upstreamHash = hashSkillFiles(skill.files);
    const recorded = manifest.skills[skill.name]?.hash;
    if (!recorded) continue; // not a moh-owned skill
    const current = installedHash(options.mohHome, skill.name);
    if (current !== recorded) continue; // modified: skip
    if (current === upstreamHash) continue; // already current
    updates.push({ name: skill.name, currentHash: current, upstreamHash, files: skill.files });
  }
  return updates;
}

/** Unified diff between two file sets, `path` by sorted path. */
export function diffSkillFiles(current: Record<string, string>, next: Record<string, string>): string {
  const lines: string[] = [];
  for (const path of [...new Set([...Object.keys(current), ...Object.keys(next)])].sort()) {
    const a = current[path];
    const b = next[path];
    if (a === b) continue;
    lines.push(`--- a/${path}`, `+++ b/${path}`);
    const al = (a ?? "").split("\n");
    const bl = (b ?? "").split("\n");
    const max = Math.max(al.length, bl.length);
    for (let i = 0; i < max; i++) {
      const x = al[i];
      const y = bl[i];
      if (x === y) continue;
      if (x !== undefined) lines.push(`-${x}`);
      if (y !== undefined) lines.push(`+${y}`);
    }
  }
  return lines.join("\n");
}

export interface ApplyUpstreamOptions {
  mohHome: string;
  updates: UpstreamUpdate[];
  /**
   * Consent seam: shown the diff, decides whether the update is applied.
   * Returning false leaves the skill untouched.
   */
  consent: (update: UpstreamUpdate, diff: string) => Promise<boolean> | boolean;
  /** Installed-file reader (tests). Default: direct fs. */
  readInstalled?: (mohHome: string, name: string) => Record<string, string>;
  writeInstalled?: (mohHome: string, name: string, files: Record<string, string>) => void;
}

export interface ApplyUpstreamReport {
  applied: string[];
  declined: string[];
  /** Re-check found the local copy modified since the plan was built. */
  skippedModified: string[];
}

/**
 * Applies upstream updates one by one. The consent callback receives the
 * full diff; nothing is ever overwritten without it. A final hash check
 * re-verifies the copy is unmodified right before writing.
 */
export async function applyUpstreamUpdates(options: ApplyUpstreamOptions): Promise<ApplyUpstreamReport> {
  const readInstalled =
    options.readInstalled ??
    ((mohHome: string, name: string) => {
      const dir = join(mohHome, "skills", name);
      const files: Record<string, string> = {};
      if (existsSync(dir)) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name !== FIRST_PARTY_MANIFEST) {
            files[entry.name] = readFileSync(join(dir, entry.name), "utf8");
          }
        }
      }
      return files;
    });
  const writeInstalled =
    options.writeInstalled ??
    ((mohHome: string, name: string, files: Record<string, string>) => {
      const dir = join(mohHome, "skills", name);
      mkdirSync(dir, { recursive: true });
      for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    });
  const manifest = loadFirstPartyManifest(options.mohHome);
  const report: ApplyUpstreamReport = { applied: [], declined: [], skippedModified: [] };
  for (const update of options.updates) {
    const currentFiles = readInstalled(options.mohHome, update.name);
    if (hashSkillFiles(currentFiles) !== update.currentHash) {
      report.skippedModified.push(update.name);
      continue;
    }
    const diff = diffSkillFiles(currentFiles, update.files);
    const ok = await options.consent(update, diff);
    if (!ok) {
      report.declined.push(update.name);
      continue;
    }
    // re-verify after the (possibly async) consent round-trip
    if (hashSkillFiles(readInstalled(options.mohHome, update.name)) !== update.currentHash) {
      report.skippedModified.push(update.name);
      continue;
    }
    writeInstalled(options.mohHome, update.name, update.files);
    manifest.skills[update.name] = { hash: update.upstreamHash, installedAt: new Date().toISOString() };
    report.applied.push(update.name);
  }
  if (report.applied.length > 0) saveFirstPartyManifest(options.mohHome, manifest);
  return report;
}
