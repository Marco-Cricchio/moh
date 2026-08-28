#!/usr/bin/env bun
/**
 * Build entrypoint: compiles moh into self-contained per-platform binaries.
 *
 * Spec: docs/spec/cli-binary-distribution.md · ADR-0013 · Issue #266.
 *
 * Usage (from the repo root):
 *   bun scripts/build.ts            # all targets
 *   bun scripts/build.ts darwin-arm64 linux-x64   # subset by platform
 *
 * Produces in dist/:
 *   moh-<platform>       self-contained binary (Bun runtime embedded)
 *   checksums.txt        sha256 of each artifact
 *
 * The first-party skills bundle (packages/core/assets/skills) is embedded as
 * file assets; a generated module registers them on `globalThis.__MOH_EMBEDDED_SKILLS__`
 * keyed by path relative to the skills dir (consumption is wired in #267).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CryptoHasher } from "bun";
import { spawnSync } from "node:child_process";

/** Platform targets for 0.1.0 (ADR-0013; Windows deferred). */
export const TARGETS = [
  { platform: "darwin-arm64", target: "bun-darwin-arm64" },
  { platform: "darwin-x64", target: "bun-darwin-x64" },
  { platform: "linux-x64", target: "bun-linux-x64" },
] as const;

export type Platform = (typeof TARGETS)[number]["platform"];

const ROOT = resolve(import.meta.dir, "..");
const SKILLS_DIR = join(ROOT, "packages", "core", "assets", "skills");
const DIST = join(ROOT, "dist");
const BUILD_DIR = join(DIST, ".build");

/**
 * Version stamped into the binary: the `v*` git tag on the exact HEAD commit
 * if present, otherwise the CLI package version (dev/unreleased builds).
 */
export function resolveVersion(root: string, gitDescribe = describe(root)): string {
  const tag = gitDescribe?.match(/^v(.+)$/)?.[1];
  if (tag) return tag;
  const pkg = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
  return pkg.version as string;
}

function describe(root: string): string | null {
  const r = spawnSync("git", ["describe", "--tags", "--exact-match"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** sha256 hex digest of a file (Bun.CryptoHasher). */
export function sha256File(path: string): string {
  const hasher = new CryptoHasher("sha256");
  hasher.update(readFileSync(path));
  return hasher.digest("hex");
}

/** All files under the skills bundle as { rel, abs }, sorted for stable output. */
export function skillFiles(skillsDir: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // .DS_Store and friends
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push({ rel: relative(skillsDir, abs), abs });
    }
  };
  walk(skillsDir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Identifier-safe asset import name, unique per file. */
export function assetKey(index: number): string {
  return `f${index}`;
}

/**
 * Generates the temporary build entry: imports the CLI plus a skills module
 * that embeds every bundled skill file (`with { type: "file" }`) and registers
 * them on `globalThis.__MOH_EMBEDDED_SKILLS__` keyed by path relative to the
 * skills directory.
 */
function writeBuildEntry(): string {
  mkdirSync(BUILD_DIR, { recursive: true });
  const files = skillFiles(SKILLS_DIR);
  const imports = files
    .map((f, i) => `import ${assetKey(i)} from ${JSON.stringify(f.abs)} with { type: "file" };`)
    .join("\n");
  const registry = `{\n${files.map((f, i) => `  ${JSON.stringify(f.rel)}: ${assetKey(i)},`).join("\n")}\n}`;
  const skillsPath = join(BUILD_DIR, "skills.ts");
  writeFileSync(
    skillsPath,
    `${imports}\n\n(globalThis as Record<string, unknown>).__MOH_EMBEDDED_SKILLS__ = ${registry};\n`,
  );
  const entryPath = join(BUILD_DIR, "entry.ts");
  writeFileSync(
    entryPath,
    `import "./skills";\nimport { runCli } from ${JSON.stringify(join(ROOT, "packages", "cli", "src", "cli"))};\n\nprocess.exitCode = await runCli();\n`,
  );
  return entryPath;
}

function buildTarget(platform: Platform, version: string): string {
  const target = TARGETS.find((t) => t.platform === platform)!;
  const outfile = join(DIST, `moh-${platform}`);
  const args = [
    "build",
    "--compile",
    "--target", target.target,
    "--define", `__MOH_BUILD_VERSION__:${JSON.stringify(version)}`,
    "--outfile", outfile,
    writeBuildEntry(),
  ];
  console.log(`▶ bun ${args.join(" ")}`);
  const r = spawnSync("bun", args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`build failed for ${platform} (exit ${r.status})`);
  return outfile;
}

function main(): number {
  const requested = process.argv.slice(2);
  const invalid = requested.filter((p) => !TARGETS.some((t) => t.platform === p));
  if (invalid.length) {
    process.stderr.write(`unknown platform(s): ${invalid.join(", ")} — known: ${TARGETS.map((t) => t.platform).join(", ")}\n`);
    return 2;
  }
  const platforms = (requested.length ? requested : TARGETS.map((t) => t.platform)) as Platform[];
  const version = resolveVersion(ROOT);
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const lines: string[] = [];
  for (const platform of platforms) {
    const outfile = buildTarget(platform, version);
    const hash = sha256File(outfile);
    lines.push(`${hash}  moh-${platform}`);
    console.log(`✓ dist/moh-${platform} (${(statSync(outfile).size / 1e6).toFixed(1)} MB) ${hash}`);
  }
  writeFileSync(join(DIST, "checksums.txt"), lines.join("\n") + "\n");
  console.log(`✓ dist/checksums.txt — moh ${version}, ${platforms.length} target(s)`);
  return 0;
}

if (import.meta.main) process.exit(main());
