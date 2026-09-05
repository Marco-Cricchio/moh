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
import { dirname, join, resolve } from "node:path";
import { parseSkillFrontmatter, FIRST_PARTY_MANIFEST, firstPartySkillNames } from "./skills";

/** The moh version skills compare their `minMohVersion` against. */
export const MOH_VERSION = "0.1.0";

/** Default upstream index for first-party skills (opt-out, background).
 * Served raw from the moh repo's main branch (skills update with released
 * versions; `minMohVersion` gates applicability): the first-party bundle
 * lives at `packages/core/assets/skills` and `index.json` there is generated
 * by `scripts/gen-skills-index.ts` (#344 — the old `moh-workflow/skills`
 * org URL never existed). */
export const DEFAULT_UPSTREAM_URL =
  "https://raw.githubusercontent.com/Marco-Cricchio/moh/main/packages/core/assets/skills/index.json";

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
  // Only top-level files (`<skill>/<file>`), matching the on-disk reader.
  const bySkill = new Map<string, Map<string, string>>();
  for (const [rel, abs] of Object.entries(registry)) {
    const slash = rel.indexOf("/");
    if (slash <= 0 || rel.indexOf("/", slash + 1) !== -1) continue;
    const name = rel.slice(0, slash);
    const file = rel.slice(slash + 1);
    if (!bySkill.has(name)) bySkill.set(name, new Map());
    bySkill.get(name)!.set(file, abs);
  }
  const sources: FirstPartySkillSource[] = [];
  for (const [name, files] of bySkill) {
    const skillAbs = files.get("SKILL.md");
    if (!skillAbs) continue;
    const source = toSkillSource(name, new Map([...files].map(([f, abs]) => [f, readFileSync(abs, "utf8")])));
    if (source) sources.push(source);
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

function readdirFiles(dir: string, skip: string[] = []): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && !skip.includes(entry.name)) files[entry.name] = readFileSync(join(dir, entry.name), "utf8");
  }
  return files;
}

/** Builds one skill source from its files (SKILL.md always present); null when unparsable. */
function toSkillSource(name: string, files: Map<string, string>): FirstPartySkillSource | null {
  const raw = files.get("SKILL.md");
  if (raw === undefined) return null;
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed) return null;
  const minMohVersion = /^minMohVersion:\s?(.+)$/m.exec(raw)?.[1]?.trim();
  return {
    ...parsed,
    ...(minMohVersion ? { minMohVersion } : {}),
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Reads the bundled first-party skills from `bundleDir` (tests inject). */
export function firstPartySkillSources(bundleDir: string = defaultBundleDir()): FirstPartySkillSource[] {
  if (!existsSync(bundleDir)) return [];
  const sources: FirstPartySkillSource[] = [];
  for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(bundleDir, entry.name);
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    const source = toSkillSource(entry.name, new Map(Object.entries(readdirFiles(dir))));
    if (source) sources.push(source);
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

/** Strict skill-name pattern (#352/SEC-02): one plain segment — no path
 * separators, no `..`, cannot start with a dot or dash. Anything the
 * network (or a bundle) tries to use as a directory name must match. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validates one skill entry (name + file keys) before anything is hashed,
 * planned or written (#352/SEC-02). File keys must be a single shallow
 * segment (`SKILL.md`), never a path, never `..`. Returns null when valid,
 * a reason string when the entry is malformed/malicious.
 */
export function validateSkillEntry(name: string, files: Record<string, string>): string | null {
  if (typeof name !== "string" || !SKILL_NAME_RE.test(name)) return `invalid skill name "${String(name)}"`;
  for (const key of Object.keys(files ?? {})) {
    if (key === "" || key === "." || key === ".." || key.includes("/") || key.includes("\\")) {
      return `invalid file key "${key}" for skill "${name}"`;
    }
  }
  return null;
}

/**
 * Containment-checked write of a skill's files under `<mohHome>/skills/<name>`
 * (#352/SEC-02). Validation above should already have rejected anything
 * hostile; this is the independent belt-and-braces check — every resolved
 * write target must have the skill directory as its direct parent.
 */
function writeSkillFiles(mohHome: string, name: string, files: Record<string, string>): void {
  const dir = resolve(mohHome, "skills", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(dir, path);
    if (dirname(target) !== dir) throw new Error(`skill file "${path}" escapes the skills directory`);
    writeFileSync(target, content, { mode: 0o600 });
  }
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
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
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
  /** Malformed entries (bad name/file key) rejected by validation — never written (#352). */
  skippedInvalid: string[];
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
    skippedInvalid: [],
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
    if (validateSkillEntry(source.name, source.files)) {
      report.skippedInvalid.push(source.name);
      continue;
    }
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
    writeSkillFiles(options.mohHome, source.name, source.files);
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
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  /** Timeout applied to the default fetch. Default: 5s. */
  timeoutMs?: number;
  /** The shipped first-party bundle to compare against (#517). Default:
   * `bundledSkillSources()` — the same source launch sync installs from. */
  bundledSources?: FirstPartySkillSource[];
}

/** Result of the upstream check (#344): a checked-but-empty channel is
 * `ok` with no updates; an unreachable, non-OK, malformed, or invalid
 * upstream is an explicit failure. Callers decide fail-silence — the
 * background startup check ignores failures, explicit commands surface
 * them; "no updates" must always mean "checked and current". */
export type UpstreamCheckResult =
  | { ok: true; updates: UpstreamUpdate[] }
  | { ok: false; reason: string };

/**
 * Upstream update check (#36, #344): fetches the upstream index and returns
 * the updates applicable to *unmodified* local copies. Modified skills
 * are skipped by the hash check; min-version-gated ones are skipped.
 * Upstream failures are explicit (`{ ok: false, reason }`); callers decide
 * whether to stay silent (background check) or surface them (`/skills update`).
 *
 * #517: an entry whose content equals the *bundled* copy is not offered,
 * even when the local disk copy differs from both — launch sync would
 * revert the apply on the next launch, producing a perpetual update
 * notice. The offer is real only when upstream differs from the bundle.
 */
export async function checkUpstreamUpdates(options: CheckUpstreamOptions): Promise<UpstreamCheckResult> {
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
  let raw: string;
  try {
    const res = await fetchImpl(options.upstream ?? DEFAULT_UPSTREAM_URL);
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    raw = await res.text();
  } catch (e) {
    return { ok: false, reason: `unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  let index: UpstreamIndex;
  try {
    index = JSON.parse(raw) as UpstreamIndex;
  } catch {
    return { ok: false, reason: "malformed index" };
  }
  if (!index || !Array.isArray(index.skills)) return { ok: false, reason: "invalid index" };
  const manifest = loadFirstPartyManifest(options.mohHome);
  const bundledHashes = new Map(
    (options.bundledSources ?? bundledSkillSources()).map((s) => [s.name, hashSkillFiles(s.files)]),
  );
  const updates: UpstreamUpdate[] = [];
  for (const skill of index.skills) {
    if (typeof skill?.name !== "string" || typeof skill.files !== "object" || skill.files === null) continue;
    // #352/SEC-02: a traversal-bearing entry makes the whole index hostile,
    // not drifted — reject the check instead of planning those updates.
    const invalid = validateSkillEntry(skill.name, skill.files);
    if (invalid) return { ok: false, reason: `invalid index entry: ${invalid}` };
    if (skill.minMohVersion && !versionSatisfied(skill.minMohVersion, MOH_VERSION)) continue;
    const upstreamHash = hashSkillFiles(skill.files);
    const recorded = manifest.skills[skill.name]?.hash;
    if (!recorded) continue; // not a moh-owned skill
    const current = installedHash(options.mohHome, skill.name);
    if (current !== recorded) continue; // modified: skip
    if (current === upstreamHash) continue; // already current
    if (bundledHashes.get(skill.name) === upstreamHash) continue; // #517: upstream equals the bundle — launch sync owns this copy
    updates.push({ name: skill.name, currentHash: current, upstreamHash, files: skill.files });
  }
  return { ok: true, updates };
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
  /** Malformed updates (bad name/file key) rejected by validation — never written (#352). */
  skippedInvalid: string[];
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
    ((mohHome: string, name: string, files: Record<string, string>) => writeSkillFiles(mohHome, name, files));
  const manifest = loadFirstPartyManifest(options.mohHome);
  const report: ApplyUpstreamReport = { applied: [], declined: [], skippedModified: [], skippedInvalid: [] };
  for (const update of options.updates) {
    if (validateSkillEntry(update.name, update.files)) {
      report.skippedInvalid.push(update.name);
      continue;
    }
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
