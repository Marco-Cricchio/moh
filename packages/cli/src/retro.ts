import { homedir } from "node:os";
import { resolve } from "node:path";
import { RetroStore, type RetroReportFinding } from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const RETRO_USAGE = `usage: moh retro [--json] [--dismiss <signature>] [--apply <signature>] [--cwd <dir>]

Review accumulated retro findings. Findings are ordered by confidence; prior
same-category dismissals are shown as lineage. Dismiss is durable. Apply only
prints the proposed last-mile change and requires a separate human confirmation
before any steering file is changed.`;

function render(store: RetroStore): string {
  const report = store.report();
  if (report.findings.length === 0) return "No retro findings.\n";
  return report.findings.map((finding: RetroReportFinding, index: number) => {
    const lineage = finding.lineage ? `; dismissed in similar form on ${finding.lineage.slice(0, 10)}` : "";
    return `${index + 1}. [${finding.category}] confidence ${(finding.confidence * 100).toFixed(0)}%\n   ${finding.evidence}${lineage}\n   signature: ${finding.signature}\n`;
  }).join("\n");
}

export async function retroCommand({
  argv,
  home,
  cwd = process.cwd(),
}: { argv: string[]; home?: string; cwd?: string }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, { strings: ["cwd", "dismiss", "apply"], booleans: ["json"] });
  } catch (error) {
    if (error instanceof ArgError) {
      process.stderr.write(`moh retro: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const root = parsed.strings.cwd ? resolve(parsed.strings.cwd) : cwd;
  const store = RetroStore.forProject(root, home ? resolve(home, ".moh") : undefined);
  if (parsed.strings.dismiss) {
    const finding = store.read().find((item: { signature: string }) => item.signature === parsed.strings.dismiss);
    if (!finding) {
      process.stderr.write(`moh retro: no finding with signature "${parsed.strings.dismiss}"\n`);
      return 2;
    }
    store.dismiss(finding.signature);
    process.stdout.write(`dismissed: ${finding.signature}\n`);
    return 0;
  }
  if (parsed.strings.apply) {
    const finding = store.read().find((item: { signature: string }) => item.signature === parsed.strings.apply);
    if (!finding) {
      process.stderr.write(`moh retro: no finding with signature "${parsed.strings.apply}"\n`);
      return 2;
    }
    process.stdout.write(`proposed application for ${finding.signature}: ${finding.evidence}\n`);
    process.stdout.write("No files were changed; confirm and apply the proposal explicitly.\n");
    return 0;
  }
  if (parsed.booleans.json) {
    process.stdout.write(`${JSON.stringify(store.report(), null, 2)}\n`);
  } else {
    process.stdout.write(render(store));
  }
  return 0;
}
