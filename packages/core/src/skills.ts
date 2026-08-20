import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pi-compatible skills loader (#30): skills/<name>/SKILL.md files with
 * `name`+`description` frontmatter, discovered from `~/.moh/skills` (user)
 * and `.moh/skills` (project; wins on name clash). Progressive disclosure:
 * only the name—description index enters the system prompt; the full
 * SKILL.md is loaded via the read tool on demand. No auto-triggering.
 */

/** One discovered skill: index data plus its on-disk location. */
export interface DiscoveredSkill {
  name: string;
  description: string;
  /** The skill directory; relative references inside SKILL.md resolve against it. */
  dir: string;
  /** Absolute path of the SKILL.md file. */
  file: string;
  /** Where it was found: project-level wins on clash. */
  source: "user" | "project";
}

/**
 * Parses the YAML-ish frontmatter of a SKILL.md. Pi format: a leading
 * `---` block containing `name` and `description` single-line values.
 * Returns null when either key is missing or there is no frontmatter.
 */
export function parseSkillFrontmatter(raw: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (kv) fields.set(kv[1]!, kv[2]!.trim());
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) return null;
  return { name, description };
}

export interface DiscoverSkillsOptions {
  /** User-level moh dir (`~/.moh`). Default: `<homedir>/.moh`. */
  mohHome?: string;
  /** Project root; skills are read from `<projectDir>/.moh/skills`. */
  projectDir?: string;
}

/**
 * Discovers skills at both levels. Project-level entries win on name
 * clash (both keep their own dir/file). Dirs without a valid SKILL.md
 * are skipped silently; missing roots are not errors.
 */
export function discoverSkills(options: DiscoverSkillsOptions = {}): DiscoveredSkill[] {
  const mohHome = options.mohHome ?? join(homedir(), ".moh");
  const projectDir = options.projectDir ?? process.cwd();
  const roots: { dir: string; source: "user" | "project" }[] = [
    { dir: join(mohHome, "skills"), source: "user" },
    { dir: join(projectDir, ".moh", "skills"), source: "project" },
  ];
  const byName = new Map<string, DiscoveredSkill>();
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(root.dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const parsed = parseSkillFrontmatter(readFileSync(file, "utf8"));
      if (!parsed) continue;
      byName.set(parsed.name, { ...parsed, dir: join(root.dir, entry.name), file, source: root.source });
    }
  }
  return [...byName.values()];
}
