/**
 * Generates the first-party skills upstream index (#344).
 *
 * Writes `packages/core/assets/skills/index.json` — the file served raw
 * from the moh repo's main branch as the skills update channel
 * (DEFAULT_UPSTREAM_URL in packages/core/src/workflow.ts). Run it whenever
 * a bundled skill changes and commit the result together with the change,
 * so installed copies see the update via `/skills update`.
 *
 * Shape (UpstreamIndex): { skills: [{ name, files, minMohVersion? }] },
 * name/minMohVersion from the SKILL.md frontmatter, files = every file in
 * the skill directory (path-sorted, stable output).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const bundleDir = join(import.meta.dir, "../packages/core/assets/skills");

function walkFiles(dir: string, base = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, walkFiles(abs, base));
    else files[abs.slice(base.length + 1)] = readFileSync(abs, "utf8");
  }
  return files;
}

const skills = [];
for (const entry of readdirSync(bundleDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const dir = join(bundleDir, entry.name);
  if (!existsSync(join(dir, "SKILL.md"))) continue;
  const raw = readFileSync(join(dir, "SKILL.md"), "utf8");
  const name = /^name:\s?(.+)$/m.exec(raw)?.[1]?.trim();
  if (!name) {
    console.error(`${entry.name}: SKILL.md has no name frontmatter — skipped`);
    process.exit(1);
  }
  const minMohVersion = /^minMohVersion:\s?(.+)$/m.exec(raw)?.[1]?.trim();
  skills.push({ name, ...(minMohVersion ? { minMohVersion } : {}), files: walkFiles(dir) });
}

const out = join(bundleDir, "index.json");
writeFileSync(out, JSON.stringify({ skills }, null, 2) + "\n");
console.log(`${out}: ${skills.length} skills (${skills.map((s) => s.name).join(", ")})`);
