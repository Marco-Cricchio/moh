/**
 * `moh init` (#11/#36): scaffold the agent-docs layout in a project —
 * `docs/agents/{issue-tracker,triage-labels,domain}.md` plus a moh
 * section in AGENTS.md. Non-destructive: existing files are never
 * overwritten, only reported as "kept". Pi migration: when CLAUDE.md
 * exists and AGENTS.md does not, the AGENTS.md file is created from it
 * (the original is left in place — moh keeps reading it as fallback).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

const AGENTS_SECTION = `## moh

- Workflow mode (optional): \`/workflow on\` in the TUI; first-party skills
  (plan, implement, review, diagnose, dream) and the frontier panel.
- The tracker (\`tracker_list\` / \`tracker_claim\` tools) follows the same
  permission engine as any tool.
`;

export interface InitOptions {
  cwd: string;
  stdout?: NodeJS.WritableStream;
}

export interface InitReport {
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
