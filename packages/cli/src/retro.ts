import { homedir } from "node:os";
import { resolve } from "node:path";
import { RetroStore, type RetroFinding } from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const RETRO_USAGE = `usage: moh retro [--cwd <dir>] [--json]
       moh retro --dismiss <signature> [--cwd <dir>]
       moh retro --apply <signature> --yes [--cwd <dir>]

Reviews accumulated project improvement findings. Findings are ordered by
confidence, then by age. Dismiss records a durable decision for that exact
evidence signature. Apply requires --yes and writes only the approved finding
to the project retro decisions ledger; it never changes steering files or the
system prompt automatically.`;

export interface RetroCommandOptions {
  argv: string[];
  cwd?: string;
  home?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

const out = (o: RetroCommandOptions) => o.stdout ?? process.stdout;
const err = (o: RetroCommandOptions) => o.stderr ?? process.stderr;

function report(store: RetroStore, json: boolean, output: { write(s: string): void }): void {
  const findings = store.read().sort((a, b) => b.confidence - a.confidence || a.appendedAt.localeCompare(b.appendedAt));
  const dismissed = store.dismissed();
  const lineage = (finding: RetroFinding) => findings.filter((other) =>
    other.signature !== finding.signature && other.category === finding.category &&
    other.evidence.split(" ")[0] === finding.evidence.split(" ")[0],
  ).map((other) => ({ signature: other.signature, appendedAt: other.appendedAt, dismissed: dismissed.has(other.signature) }));
  if (json) {
    output.write(JSON.stringify(findings.map((finding) => ({ ...finding, lineage: lineage(finding) })), null, 2) + "\n");
    return;
  }
  if (findings.length === 0) {
    output.write("No retro findings.\n");
    return;
  }
  output.write(`Retro findings (${findings.length})\n\n`);
  for (const [index, finding] of findings.entries()) {
    output.write(`${index + 1}. [${finding.category}] confidence ${finding.confidence.toFixed(2)}\n`);
    output.write(`   ${finding.evidence}\n`);
    output.write(`   signature: ${finding.signature} · session: ${finding.session}\n`);
    const related = lineage(finding);
    if (related.length) output.write(`   lineage: ${related.map((item) => `${item.dismissed ? "dismissed" : "observed"} ${item.appendedAt}`).join(", ")}\n`);
  }
  output.write("\nUse `moh retro --dismiss <signature>` to dismiss one finding.\n");
  output.write("Use `moh retro --apply <signature> --yes` to record an approved application.\n");
}

export function retroCommand(options: RetroCommandOptions): number {
  let parsed;
  try {
    parsed = parseArgs(options.argv, { strings: ["cwd", "dismiss", "apply"], booleans: ["json", "yes"] });
  } catch (error) {
    if (error instanceof ArgError) {
      err(options).write(`moh retro: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (parsed.strings.dismiss && parsed.strings.apply) {
    err(options).write("moh retro: --dismiss and --apply are mutually exclusive\n");
    return 2;
  }
  const cwd = resolve(parsed.strings.cwd ?? options.cwd ?? process.cwd());
  const store = RetroStore.forProject(cwd, options.home ?? homedir());
  const signature = parsed.strings.dismiss ?? parsed.strings.apply;
  if (!signature) {
    report(store, parsed.booleans.json === true, out(options));
    return 0;
  }
  const finding = store.read().find((item) => item.signature === signature);
  if (!finding) {
    err(options).write(`moh retro: finding "${signature}" was not found\n`);
    return 2;
  }
  if (parsed.strings.dismiss) {
    store.dismiss(signature);
    out(options).write(`dismissed: ${signature}\n`);
    return 0;
  }
  if (!parsed.booleans.yes) {
    err(options).write("moh retro: --apply requires explicit --yes confirmation; no files were changed\n");
    return 2;
  }
  store.recordApplication(finding);
  out(options).write(`applied decision recorded: ${signature}\n`);
  return 0;
}
