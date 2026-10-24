/**
 * `moh init` (#11/#36): scaffold the agent-docs layout in a project —
 * `docs/agents/{issue-tracker,triage-labels,domain,code-quality}.md` plus a moh
 * section in AGENTS.md, and a moh.json carrying the proposed `checks`
 * (ADR-0080). Non-destructive: existing files are never
 * overwritten, only reported as "kept". Pi migration: when CLAUDE.md
 * exists and AGENTS.md does not, the AGENTS.md file is created from it
 * (the original is left in place — moh keeps reading it as fallback).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MohConfig } from "@moh/core";

const ISSUE_TRACKER_MD = `# Issue tracker

Issues live in the project's tracker and are managed via the \`tracker_list\` /
\`tracker_claim\` tools (backends: gh, gitlab, local markdown in \`.moh/tracker/\`).

- One issue per unit of work; acceptance criteria as checkboxes.
- Claim an issue before starting work; close it from the PR.
`;

const TRIAGE_LABELS_MD = `# Triage labels

- needs-triage — not yet reviewed
- needs-info — waiting on the reporter
- ready-for-agent — actionable by an agent, no human input needed
- ready-for-human — requires the owner
- wontfix — rejected; keep the rationale in the issue
`;

const DOMAIN_MD = `# Domain docs

- Root \`CONTEXT.md\` holds the glossary: the shared vocabulary of the project.
- \`docs/adr/\` holds architecture decision records; one decision per file,
  dated, with context and consequences.
`;

// ADR-0079: principle 8's posture only — moh's own rules (a)–(f) stay in moh.
const CODE_QUALITY_MD = `# Code quality

Lean by default. These hold for any agent or person changing this repository;
where this repository's own conventions say otherwise, they win.

- Every abstraction, option and export has a caller in the same change.
- One fact, one place: before adding a list, map, constant or helper, find the
  existing one and extend it.
- Extend an existing file before creating a new one.
- A change that leaves code unused deletes it in the same change.
- Thresholds for dead code, duplication or complexity, if any, are this
  repository's to set.
- If \`moh.json\` declares \`checks\`, run them before calling a change done.
`;

type Check = NonNullable<MohConfig["checks"]>[number];

/** ADR-0080: pinned on-demand commands, proposed when the repo has no tool of its own. */
const DEFAULT_CHECKS: Check[] = [
  { name: "duplication", run: "npx --yes jscpd@4.0.5 --silent --gitignore --min-tokens 50 --threshold 3 ." },
  { name: "complexity", run: 'uvx --from lizard==1.17.10 lizard -C 15 -i 0 -x "./node_modules/*" .' },
];

/** The checks `moh init` proposes: the repo's own tools when present, else the pinned defaults. */
function proposedChecks(cwd: string): Check[] {
  const read = (rel: string): string => (existsSync(join(cwd, rel)) ? readFileSync(join(cwd, rel), "utf8") : "");
  let deps: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(read("package.json") || "{}") as { dependencies?: object; devDependencies?: object };
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    // A malformed package.json proposes nothing from it.
  }
  const pyproject = read("pyproject.toml");
  const found: Check[] = [];
  if ("knip" in deps) found.push({ name: "knip", run: "npx knip" });
  if ("eslint" in deps) found.push({ name: "eslint", run: "npx eslint ." });
  if (/\bruff\b/.test(pyproject)) found.push({ name: "ruff", run: "ruff check ." });
  if (/\bradon\b/.test(pyproject)) found.push({ name: "radon", run: "radon cc -n C ." });
  return found.length > 0 ? found : DEFAULT_CHECKS;
}

const AGENTS_SECTION = `## moh

- Workflow mode (optional): \`/workflow on\` in the TUI; first-party skills
  (plan, implement, review, diagnose, dream) and the frontier panel.
- The tracker (\`tracker_list\` / \`tracker_claim\` tools) follows the same
  permission engine as any tool.
- Code quality: follow \`docs/agents/code-quality.md\`.
`;

interface InitOptions {
  cwd: string;
  stdout?: NodeJS.WritableStream;
}

interface InitReport {
  created: string[];
  /** Existing files left untouched. */
  kept: string[];
  /** Pi migration: AGENTS.md created from CLAUDE.md. */
  migratedFromClaude: boolean;
}

/** Scaffolds the agent-docs layout. Never overwrites an existing file. */
export function initCommand(options: InitOptions): InitReport {
  const out = options.stdout ?? process.stdout;
  const report: InitReport = { created: [], kept: [], migratedFromClaude: false };

  const write = (rel: string, content: string): void => {
    const file = join(options.cwd, rel);
    if (existsSync(file)) {
      report.kept.push(rel);
      out.write(`kept    ${rel} (already exists)\n`);
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    report.created.push(rel);
    out.write(`created ${rel}\n`);
  };

  write("docs/agents/issue-tracker.md", ISSUE_TRACKER_MD);
  write("docs/agents/triage-labels.md", TRIAGE_LABELS_MD);
  write("docs/agents/domain.md", DOMAIN_MD);
  write("docs/agents/code-quality.md", CODE_QUALITY_MD);

  // ADR-0080: an existing moh.json is the user's — print the proposal, never edit it.
  const checks = JSON.stringify({ checks: proposedChecks(options.cwd) }, null, 2);
  const mohJson = join(options.cwd, "moh.json");
  if (existsSync(mohJson)) {
    report.kept.push("moh.json");
    const declared = readFileSync(mohJson, "utf8").includes('"checks"');
    out.write(declared ? "kept    moh.json (checks already declared)\n" : `kept    moh.json (already exists) — proposed checks to add:\n${checks}\n`);
  } else {
    write("moh.json", `${checks}\n`);
  }

  const agentsFile = join(options.cwd, "AGENTS.md");
  const claudeFile = join(options.cwd, "CLAUDE.md");
  if (existsSync(agentsFile)) {
    const existing = readFileSync(agentsFile, "utf8");
    if (existing.includes("## moh")) {
      report.kept.push("AGENTS.md");
      out.write("kept    AGENTS.md (moh section already present)\n");
    } else {
      writeFileSync(agentsFile, `${existing.replace(/\n*$/, "\n\n")}${AGENTS_SECTION}`);
      report.created.push("AGENTS.md (section)");
      out.write("created AGENTS.md section\n");
    }
  } else if (existsSync(claudeFile)) {
    // Pi migration: carry the instructions over, original stays in place.
    writeFileSync(agentsFile, readFileSync(claudeFile, "utf8").replace(/\n*$/, "\n\n") + AGENTS_SECTION);
    report.migratedFromClaude = true;
    report.created.push("AGENTS.md");
    out.write("created AGENTS.md (migrated from CLAUDE.md; original kept)\n");
  } else {
    write("AGENTS.md", `# Agents\n\n${AGENTS_SECTION}`);
  }
  return report;
}
