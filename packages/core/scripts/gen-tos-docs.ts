#!/usr/bin/env bun
/**
 * Regenerates docs/providers/tos/ from the bundled ToS card assets
 * (packages/core/src/tos-cards/*.json) — the assets are the single source
 * of truth (#444); docs never diverge because they are always generated.
 *
 * Usage: bun packages/core/scripts/gen-tos-docs.ts
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const ASSETS = join(ROOT, "packages", "core", "src", "tos-cards");
const DOCS = join(ROOT, "docs", "providers", "tos");

interface TosCard {
  provider: string;
  verified: string;
  allowed: string[];
  forbidden: string[];
  retention: string;
  training: string;
  links: { label: string; url: string }[];
}

function renderMarkdown(card: TosCard): string {
  const lines: string[] = [
    `# Terms of Service — ${card.provider}`,
    "",
    `> ⚠ Machine-written informational summary; not legal advice. The original text at the linked source prevails.`,
    "",
    `Verification date: **${card.verified}**`,
    "",
    "## Allowed (API/CLI usage)",
    "",
    ...card.allowed.map((item) => `- ${item}`),
    "",
    "## Forbidden (API/CLI usage)",
    "",
    ...card.forbidden.map((item) => `- ${item}`),
    "",
    "## Data handling",
    "",
    `- **Retention:** ${card.retention}`,
    `- **Training on your inputs:** ${card.training}`,
    "",
    "## Original text",
    "",
    ...(card.links.length
      ? card.links.map((l) => `- [${l.label}](${l.url})`)
      : ["- (see the concrete backend's terms)"]),
    "",
    `Verified: ${card.verified}`,
    "",
  ];
  return lines.join("\n");
}

const files = readdirSync(ASSETS).filter((f) => f.endsWith(".json")).sort();
mkdirSync(DOCS, { recursive: true });
const cards: TosCard[] = [];
for (const file of files) {
  const card = JSON.parse(readFileSync(join(ASSETS, file), "utf8")) as TosCard;
  cards.push(card);
  writeFileSync(join(DOCS, `${card.provider}.md`), renderMarkdown(card));
}
const index = [
  "# Provider ToS summary cards",
  "",
  "Bundled, per-provider ToS summaries (one page per provider, generated from the package assets — never edit these pages directly).",
  "",
  ...cards.map((c) => `- [${c.provider}](./${c.provider}.md) (verified ${c.verified})`),
  "",
];
writeFileSync(join(DOCS, "README.md"), index.join("\n"));
console.log(`generated ${cards.length + 1} files in docs/providers/tos/`);
