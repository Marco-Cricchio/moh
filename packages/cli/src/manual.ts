/**
 * `moh manual [page]` (#457): prints the bundled user manual — the index
 * with no argument, one page by id otherwise. The same assets the TUI
 * modal renders, embedded in the core (no repo checkout, no network).
 */
import { allManualPages, manualIndex, manualPage } from "@moh/core";

export const MANUAL_USAGE = `usage: moh manual [page]

Prints a manual page, or the index with no argument. Page ids match the
TUI manual (ctrl+h / /help) and docs/manual/.`;

export interface ManualCommandOptions {
  argv: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

const out = (opts: ManualCommandOptions): NodeJS.WritableStream => opts.stdout ?? process.stdout;
const err = (opts: ManualCommandOptions): NodeJS.WritableStream => opts.stderr ?? process.stderr;

export function manualCommand(opts: ManualCommandOptions): number {
  if (opts.argv.includes("--help") || opts.argv.includes("-h")) {
    out(opts).write(MANUAL_USAGE + "\n");
    return 0;
  }
  const args = opts.argv.filter((a) => !a.startsWith("-"));
  if (args.length > 1) {
    err(opts).write(`moh manual: expected at most one page id\n\n${MANUAL_USAGE}\n`);
    return 2;
  }
  if (args.length === 0) {
    const lines = ["moh manual — the user manual", "", "id                      title",];
    for (const entry of manualIndex()) {
      lines.push(`${entry.id.padEnd(24)}${entry.title} — ${entry.summary}`);
    }
    lines.push("", "read one with: moh manual <id>", "");
    out(opts).write(lines.join("\n"));
    return 0;
  }
  const page = manualPage(args[0]!);
  if (!page) {
    const known = allManualPages().map((p) => p.id).join(", ");
    err(opts).write(`moh manual: unknown page "${args[0]}" (known: ${known})\n`);
    return 2;
  }
  out(opts).write(page.body + "\n");
  return 0;
}
