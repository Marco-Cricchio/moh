import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  RetroStore,
  applyRetroApplication,
  proposeRetroApplication,
  type RetroReportFinding,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const RETRO_USAGE = `usage: moh retro [--json] [--dismiss <signature>] [--apply <signature> [--yes]] [--cwd <dir>]

Reviews the retro findings accumulated for this project (ADR-0075).
Findings are ordered by confidence and each shows its category, evidence
and signature; prior dismissals of the same category are shown as
lineage, never hidden.

  --json              emit the report as JSON
  --dismiss <sig>     record a durable dismissal: that observation is
                      never proposed again, and repeated dismissals of a
                      category raise the bar its extraction must clear
  --apply <sig>       show the concrete change the finding proposes
                      (a rule, a check, a navigation pointer); with --yes
                      the change is written, appended under a
                      "## Retro findings" heading — existing prose is
                      never edited, and nothing is written without --yes
  --cwd <dir>         the project root (default: process.cwd())

Findings never reach the system prompt or a steering file on their own.
In the TUI, /retro opens the same report in-session.`;

/** The store for one project: `<mohHome>/projects/<slug>/retro`. */
function storeFor(cwd: string, home?: string): RetroStore {
  return RetroStore.forProject(cwd, home ? resolve(home, ".moh") : join(homedir(), ".moh"));
}

function render(report: ReturnType<RetroStore["report"]>): string {
  if (report.findings.length === 0) {
    return "No retro findings. Findings accumulate automatically as sessions close.\n";
  }
  return report.findings.map((finding, index) => {
    const application = proposeRetroApplication(finding);
    const lineage = finding.lineage ? `\n   dismissed in similar form on ${finding.lineage.slice(0, 10)}` : "";
    const target = application.target ? application.proposal : application.proposal;
    return [
      `${index + 1}. [${finding.category}] confidence ${(finding.confidence * 100).toFixed(0)}%`,
      `   ${finding.evidence}${lineage}`,
      `   proposed: ${target}${application.target ? ` (${application.target})` : ""}`,
      `   signature: ${finding.signature}`,
    ].join("\n");
  }).join("\n\n") + "\n";
}

export async function retroCommand({
  argv,
  home,
  cwd = process.cwd(),
}: { argv: string[]; home?: string; cwd?: string }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, { strings: ["cwd", "dismiss", "apply"], booleans: ["json", "yes"] });
  } catch (error) {
    if (error instanceof ArgError) {
      process.stderr.write(`moh retro: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const root = parsed.strings.cwd ? resolve(parsed.strings.cwd) : cwd;
  const store = storeFor(root, home);
  const findingFor = (signature: string): RetroReportFinding | undefined =>
    store.report().findings.find((item: RetroReportFinding) => item.signature === signature);

  if (parsed.strings.dismiss) {
    const finding = findingFor(parsed.strings.dismiss);
    if (!finding) {
      process.stderr.write(`moh retro: no finding with signature "${parsed.strings.dismiss}"\n`);
      return 2;
    }
    store.dismiss(finding.signature, new Date(), finding.category);
    process.stdout.write(`dismissed: ${finding.signature}\n`);
    return 0;
  }

  if (parsed.strings.apply) {
    const finding = findingFor(parsed.strings.apply);
    if (!finding) {
      process.stderr.write(`moh retro: no finding with signature "${parsed.strings.apply}"\n`);
      return 2;
    }
    const application = proposeRetroApplication(finding);
    if (parsed.booleans.yes !== true) {
      process.stdout.write(`proposed: ${application.proposal}\n`);
      process.stdout.write(
        application.target
          ? `target: ${application.target} — re-run with --yes to apply (existing prose is never edited)\n`
          : "this finding has no automatic target; apply it by hand\n",
      );
      return 0;
    }
    const result = applyRetroApplication({ finding, projectRoot: root, confirm: true, application });
    if (!result.ok) {
      process.stderr.write(`moh retro: ${result.error}\n`);
      return 2;
    }
    process.stdout.write(result.appended ? `applied to ${result.file}\n` : `already applied: ${result.file}\n`);
    return 0;
  }

  if (parsed.booleans.json) {
    process.stdout.write(`${JSON.stringify(store.report(), null, 2)}\n`);
  } else {
    process.stdout.write(render(store.report()));
  }
  return 0;
}
