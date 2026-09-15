/**
 * `moh usage` (#715): a thin projection over the core multi-session
 * telemetry aggregator (#714) — per-model usage (calls, input/output
 * tokens) across the project's local session files, with `--project`,
 * `--days` (session mtime window) and `--json` filters. Metadata only,
 * all local; no sessions → friendly empty message, never an error.
 */
import { homedir } from "node:os";
import { aggregateTelemetry } from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const USAGE_USAGE = `usage: moh usage [--project <slug>] [--days <N>] [--json] [--cwd <dir>]

Per-model usage report across the project's local sessions: model calls,
input and output tokens summed over every session file. Failed calls are
excluded (they consumed nothing measurable).

  --project   another project's slug (default: the current project)
  --days      only sessions modified within the last N days
  --json      machine-readable JSON (models, totals, session count)
  --cwd       project root (default: process.cwd())`;

export async function usageCommand({
  argv,
  home,
  out = process.stdout,
  err = process.stderr,
}: {
  argv: string[];
  home?: string;
  out?: { write(s: string): void };
  err?: { write(s: string): void };
}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, { strings: ["project", "days", "cwd"], booleans: ["json"] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh usage: ${e.message}\n\n${USAGE_USAGE}\n`);
      return 2;
    }
    throw e;
  }
  if (parsed.positionals.length) {
    err.write(`moh usage: unexpected argument "${parsed.positionals[0]}"\n\n${USAGE_USAGE}\n`);
    return 2;
  }
  const daysRaw = parsed.strings["days"];
  let sinceMs: number | undefined;
  if (daysRaw !== undefined) {
    const days = Number(daysRaw);
    if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
      err.write(`moh usage: --days expects a positive whole number of days\n`);
      return 2;
    }
    sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  }
  const cwd = parsed.strings["cwd"] ? parsed.strings["cwd"] : process.cwd();
  const report = aggregateTelemetry({
    cwd,
    home: home ?? homedir(),
    ...(parsed.strings["project"] ? { slug: parsed.strings["project"] } : {}),
    ...(sinceMs !== undefined ? { sinceMs } : {}),
  });

  if (parsed.booleans["json"]) {
    const totals = report.models.reduce(
      (acc, m) => ({
        calls: acc.calls + m.calls,
        inputTokens: acc.inputTokens + m.inputTokens,
        outputTokens: acc.outputTokens + m.outputTokens,
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0 },
    );
    out.write(
      JSON.stringify(
        {
          models: report.models.map(({ model, calls, inputTokens, outputTokens }) => ({
            model,
            calls,
            inputTokens,
            outputTokens,
          })),
          totals,
          sessionsScanned: report.sessionsScanned,
          sessionsSkipped: report.sessionsSkipped,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  if (report.sessionsScanned === 0) {
    err.write("No sessions found for this project — nothing to report yet.\n");
    return 0;
  }

  const modelCol = Math.max("model".length, ...report.models.map((m) => m.model.length));
  const num = (n: number): string => n.toLocaleString("en-US");
  const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));
  const rows: string[][] = [
    ["Model", "Calls", "Input tok", "Output tok"],
    ...report.models.map((m) => [m.model, num(m.calls), num(m.inputTokens), num(m.outputTokens)]),
  ];
  const widths = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => r[c]!.length)));
  out.write("Usage by model (all sessions):\n\n");
  for (const [i, row] of rows.entries()) {
    out.write(
      `  ${pad(row[0]!, widths[0]!)}  ${pad(row[1]!, widths[1]!)}  ${pad(row[2]!, widths[2]!)}  ${row[3]!}\n` +
        (i === 0 ? `  ${"─".repeat(widths[0]!)}  ${"─".repeat(widths[1]!)}  ${"─".repeat(widths[2]!)}  ${"─".repeat(widths[3]!)}\n` : ""),
    );
  }
  const totals = report.models.reduce(
    (acc, m) => ({ calls: acc.calls + m.calls, in: acc.in + m.inputTokens, out: acc.out + m.outputTokens }),
    { calls: 0, in: 0, out: 0 },
  );
  out.write(
    `\n  ${report.sessionsScanned} session${report.sessionsScanned === 1 ? "" : "s"}, ` +
      `${num(totals.calls)} call${totals.calls === 1 ? "" : "s"}, ` +
      `${num(totals.in)} in / ${num(totals.out)} out tokens\n`,
  );
  if (report.sessionsSkipped > 0) {
    err.write(`${report.sessionsSkipped} unreadable session file(s) skipped.\n`);
  }
  return 0;
}
