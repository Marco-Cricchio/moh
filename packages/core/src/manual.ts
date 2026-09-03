/**
 * The user manual (#457): markdown pages bundled as package assets and
 * statically imported so `bun build --compile` embeds them (ADR-0013, the
 * model-catalog/ToS-cards pattern). Client-agnostic: the TUI modal, the
 * `moh manual` CLI command and the /ask-moh router all consume these
 * exports through @moh/core. `docs/manual/` is a generated mirror — never
 * edited independently (same production pattern as docs/providers/tos/).
 *
 * Markdown subset (asserted by the anti-drift test): ATX headings,
 * paragraphs, bullet/numbered lists, fenced code blocks, simple tables.
 * Anything else is a test failure.
 */
import gettingStarted from "./manual/getting-started.md" with { type: "text" };
import sessions from "./manual/sessions.md" with { type: "text" };
import providersAndModels from "./manual/providers-and-models.md" with { type: "text" };
import permissions from "./manual/permissions.md" with { type: "text" };
import mcp from "./manual/mcp.md" with { type: "text" };
import skillsAndWorkflow from "./manual/skills-and-workflow.md" with { type: "text" };
import memoryAndCompaction from "./manual/memory-and-compaction.md" with { type: "text" };
import cliReference from "./manual/cli-reference.md" with { type: "text" };
import configReference from "./manual/config-reference.md" with { type: "text" };
import commandsAndKeys from "./manual/commands-and-keys.md" with { type: "text" };

/** One manual section. `id` is stable: it is the CLI page argument, the
 * TUI filter key, and the generated file name in docs/manual/. */
export interface ManualPage {
  id: string;
  title: string;
  /** One-line summary shown in the index. */
  summary: string;
  /** Full markdown body (includes the H1 title line). */
  body: string;
}

const PAGES: ReadonlyArray<ManualPage> = [
  { id: "getting-started", title: "Getting started", summary: "first run, the mock provider, your first session, where data lives", body: gettingStarted },
  { id: "sessions", title: "Sessions", summary: "new, resume, fork, handoff between machines, the event log", body: sessions },
  { id: "providers-and-models", title: "Providers & models", summary: "adding endpoints, subscription auth, switching models, thinking levels", body: providersAndModels },
  { id: "permissions", title: "Permissions & rules", summary: "the rule grammar, the permission prompt, tiers and vetoes", body: permissions },
  { id: "mcp", title: "MCP", summary: "declaring MCP servers, stdio/HTTP transports, consent and trust", body: mcp },
  { id: "skills-and-workflow", title: "Skills & workflow mode", summary: "first-party skills, /workflow on|off, slash commands, /ask-moh", body: skillsAndWorkflow },
  { id: "memory-and-compaction", title: "Memory & compaction", summary: "facts across sessions vs rebuilt context within one", body: memoryAndCompaction },
  { id: "cli-reference", title: "CLI reference", summary: "every moh command and flag (generated)", body: cliReference },
  { id: "config-reference", title: "Config reference", summary: "moh.json and ~/.moh/config keys (generated)", body: configReference },
  { id: "commands-and-keys", title: "Commands & keys", summary: "TUI keybindings and slash commands (generated)", body: commandsAndKeys },
];

/** All manual pages in reading order. */
export function allManualPages(): ReadonlyArray<ManualPage> {
  return PAGES;
}

/** One page by id (the `moh manual <id>` argument); null when unknown. */
export function manualPage(id: string): ManualPage | null {
  return PAGES.find((p) => p.id === id) ?? null;
}

/** The index view: ids, titles and summaries (no bodies). This is what
 * the TUI index renders, the CLI index prints, and /ask-moh's prompt
 * carries. */
export function manualIndex(): ReadonlyArray<Pick<ManualPage, "id" | "title" | "summary">> {
  return PAGES.map(({ id, title, summary }) => ({ id, title, summary }));
}

/** Out-of-subset construct detectors, applied line-wise outside fences:
 * raw HTML, images, reference link definitions, and setext-heading
 * underlines. Inline code/code links inside a paragraph line are
 * paragraphs — allowed. */
const OUT_OF_SUBSET: ReadonlyArray<RegExp> = [
  /<[/!]?[a-zA-Z][^>]*>/, // raw HTML — but not inline `<code>` spans
  /!\[[^\]]*\]\(/, // images
  /^\s*\[[^\]]+\]:\s*\S+/, // reference link definition
  /^ {0,3}(=+|-{3,})\s*$/, // setext heading underline / thematic break
];

/** Setext-heading detector for the page-structure check: a non-empty,
 * non-heading, non-fence line whose next non-blank line is a `---`/`===`
 * underline makes that underline a setext H2 — out of subset. */
export function setextViolations(body: string): string[] {
  const lines = body.split("\n");
  const violations: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^ {0,3}=+\s*$/.test(lines[i]!)) violations.push(lines[i]!);
  }
  return violations;
}

/** Returns the offending lines of a page body (empty = subset-clean).
 * Fence-aware: fenced code blocks are verbatim and never flagged. Pure,
 * exported for the anti-drift test and the generator. */
export function manualSubsetViolations(body: string): string[] {
  const violations: string[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const t = line.trim();
    if (t === "") continue;
    // Raw-HTML check tolerant of inline `<code>` spans inside backticks:
    // strip `code` runs first, then test.
    const prose = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    if (OUT_OF_SUBSET.some((re) => re.test(prose))) {
      violations.push(line);
      continue;
    }
  }
  return violations;
}
