#!/usr/bin/env bun
/**
 * Regenerates the manual's generated assets and the docs/manual/ mirror
 * (#457) — the sources are the live code, the assets are the output:
 *
 *  - packages/core/src/manual/cli-reference.md     ← the CLI usage texts
 *  - packages/core/src/manual/config-reference.md  ← the config schema (pinned)
 *  - packages/core/src/manual/commands-and-keys.md ← the TUI COMMANDS constant
 *  - docs/manual/<page>.md + README.md             ← the GitHub mirror
 *
 * The three reference pages are generated from code; only the narrative
 * pages are hand-written assets. An anti-drift test pins both the assets
 * and the mirror to this output — never edit these files directly.
 *
 * The CLI usage texts and the TUI COMMANDS constant are extracted by
 * regex from their source files (they are string/literal consts, stable
 * shapes pinned by tests): this keeps the generator a standalone script
 * with no cross-package imports (the TUI is not importable from core).
 *
 * Usage: bun packages/core/scripts/gen-manual-docs.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const ASSETS = join(ROOT, "packages", "core", "src", "manual");
const DOCS = join(ROOT, "docs", "manual");
const CLI_SRC = join(ROOT, "packages", "cli", "src");
const TUI_SRC = join(ROOT, "packages", "tui", "src");

// ── Extractors ──────────────────────────────────────────────────────────

/** Extracts an exported `export const NAME = \`...\`;` template literal. */
function extractUsage(name: string, file: string): string {
  const raw = readFileSync(join(CLI_SRC, file), "utf8");
  const m = new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`).exec(raw);
  if (!m) throw new Error(`cannot extract ${name} from ${file}`);
  return m[1]!;
}

/** Extracts the COMMANDS groups from CommandsPanel.tsx (literal array). */
function extractCommands(): ReadonlyArray<{ area: string; keys: ReadonlyArray<[string, string]> }> {
  const raw = readFileSync(join(TUI_SRC, "CommandsPanel.tsx"), "utf8");
  const groups: { area: string; keys: [string, string][] }[] = [];
  const groupRe = /area: "([^"]+)",\s*keys: \[([\s\S]*?)\],\s*\}/g;
  for (const m of raw.matchAll(groupRe)) {
    const keys: [string, string][] = [];
    for (const row of m[2]!.matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)) {
      keys.push([row[1]!, row[2]!]);
    }
    groups.push({ area: m[1]!, keys });
  }
  if (groups.length === 0) throw new Error("cannot extract COMMANDS from CommandsPanel.tsx");
  return groups;
}

/** Extracts the top-level HELP text from cli.ts (between backticks). */
function extractCliHelp(): string {
  const raw = readFileSync(join(CLI_SRC, "cli.ts"), "utf8");
  const m = /const HELP = `([\s\S]*?)`;/.exec(raw);
  if (!m) throw new Error("cannot extract HELP from cli.ts");
  return m[1]!;
}

// ── Generated pages ─────────────────────────────────────────────────────

function renderCommandsPage(): string {
  const groups = extractCommands();
  const lines: string[] = [
    "# Commands & keys",
    "",
    "Generated from the same `COMMANDS` constant the `?` panel renders —",
    "never edit directly (`bun packages/core/scripts/gen-manual-docs.ts`",
    "regenerates it). `?` (or `ctrl+k` in chat) opens the quick panel; this",
    "page is the same content in manual form, plus the manual's own entries",
    "(`ctrl+h`, `/help`).",
    "",
  ];
  for (const group of groups) {
    lines.push(`## ${group.area}`, "", "| Key | Action |", "| --- | --- |");
    for (const [key, action] of group.keys) {
      // Keep table cells inside the markdown subset: escape raw `<...>`
      // as inline code, and pipe characters in the key spec.
      lines.push(`| ${key.replace(/\|/g, "\\|")} | ${action.replace(/^([^`]*)(<[^>`]+>)/, (_m, a, b) => (a.includes("`") ? `${a}${b}` : `${a}\`${b}\``)).replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Manual",
    "",
    "| Key | Action |",
    "| --- | --- |",
    "| ctrl+h | open the user manual (chat and home) |",
    "| /help | the user manual (slash equivalent) |",
    "| esc | page view: back to the index (esc esc closes the manual) |",
    "",
  );
  return lines.join("\n");
}

function renderCliPage(): string {
  const sections: Array<{ heading: string; body: string }> = [
    { heading: "moh — top level", body: extractCliHelp() },
    { heading: "moh run", body: extractUsage("RUN_USAGE", "run.ts") },
    { heading: "moh mcp", body: extractUsage("MCP_USAGE", "mcp.ts") },
    { heading: "moh provider", body: extractUsage("PROVIDER_USAGE", "provider.ts") },
    {
      heading: "moh manual",
      body: `usage: moh manual [page]

Prints a manual page, or the index with no argument. Page ids match the
TUI manual (ctrl+h / /help) and docs/manual/.`,
    },
    { heading: "moh update", body: extractUsage("UPDATE_USAGE", "update.ts") },
    { heading: "moh handoff", body: extractUsage("HANDOFF_USAGE", "handoff.ts") },
  ];
  const lines: string[] = [
    "# CLI reference",
    "",
    "Generated from the CLI command definitions — never edit directly",
    "(`bun packages/core/scripts/gen-manual-docs.ts` regenerates it).",
    "",
  ];
  for (const section of sections) {
    lines.push(`## ${section.heading}`, "", "```", section.body.trim(), "```", "");
  }
  return lines.join("\n");
}

// The config page's prose depends on the schema's field set; these pins
// fail when the schema changes, telling the editor to update the page
// (the page is hand-shaped prose over a machine-checked skeleton).
const CONFIG_PAGE_PINNED_KEYS = [
  "provider",
  "endpoints",
  "permissions",
  "extensions",
  "mcpServers",
  "agents",
  "memory",
  "handoff",
  "skillRouting",
  "maxIterations",
];

function renderConfigPage(): string {
  const asset = readFileSync(join(ASSETS, "config-reference.md"), "utf8");
  for (const key of CONFIG_PAGE_PINNED_KEYS) {
    if (!asset.includes(`"${key}"`)) {
      throw new Error(`config-reference.md is missing the schema key "${key}" — update it after a schema change`);
    }
  }
  return asset;
}

// ── Write assets + mirror ───────────────────────────────────────────────

const GENERATED = new Set(["cli-reference.md", "config-reference.md", "commands-and-keys.md"]);

function pageSlug(file: string): string {
  return file.replace(/\.md$/, "");
}

function pageTitle(file: string, body: string): string {
  const h1 = /^# (.+)$/m.exec(body);
  if (h1) return h1[1]!;
  return pageSlug(file);
}

mkdirSync(DOCS, { recursive: true });

writeFileSync(join(ASSETS, "cli-reference.md"), renderCliPage());
writeFileSync(join(ASSETS, "commands-and-keys.md"), renderCommandsPage());
writeFileSync(join(ASSETS, "config-reference.md"), renderConfigPage());

// Mirror: every asset (generated refreshed above + narrative as-is), plus
// the README index. Narrative page bodies are copied verbatim.
const files = ["getting-started.md", "sessions.md", "providers-and-models.md", "permissions.md", "mcp.md", "skills-and-workflow.md", "memory-and-compaction.md", ...GENERATED].sort();
const index: string[] = [
  "# moh user manual",
  "",
  "The manual bundled in moh (`ctrl+h` or `/help` in the TUI, `moh manual`",
  "on the CLI). This directory is a generated mirror — never edit these",
  "pages directly (`bun packages/core/scripts/gen-manual-docs.ts`",
  "regenerates it).",
  "",
];
for (const file of files) {
  const body = file === "config-reference.md" ? renderConfigPage() : readFileSync(join(ASSETS, file), "utf8");
  writeFileSync(join(DOCS, file), body);
  index.push(`- [${pageTitle(file, body)}](./${file}) — ${pageSlug(file)}`);
}
index.push("", "Reference pages (CLI, config, commands & keys) are generated from code; the rest is hand-written and reviewed like docs.", "");
writeFileSync(join(DOCS, "README.md"), index.join("\n"));
console.log(`generated ${files.length + 1} files in docs/manual/ and refreshed ${GENERATED.size} assets`);
