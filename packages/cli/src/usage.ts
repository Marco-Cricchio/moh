/**
 * `moh usage` (#715/#716): a thin projection over the core multi-session
 * telemetry aggregator (#714) — three sub-reports over one aggregate:
 *
 *   moh usage          per-model usage (calls, input/output tokens)
 *   moh usage tools    per-tool calls, ok/fail, timeouts, avg duration
 *   moh usage routes   fallbacks, route_serving switches, turn errors
 *
 * All three accept `--project`, `--days` (session mtime window) and
 * `--json`. Metadata only, all local; no sessions → friendly empty
 * message, never an error.
 */
import { homedir } from "node:os";
import { aggregateTelemetry } from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const USAGE_USAGE = `usage: moh usage [tools|routes] [--project <slug>] [--days <N>] [--json] [--cwd <dir>]

Telemetry sub-reports over the project's local sessions (default: per-model
usage). Metadata only; failed model calls are excluded (they consumed
nothing measurable).

  (default)   per-model usage: model calls, input and output tokens
  tools       per-tool calls, ok/fail rate, timeouts, average call→result
              duration where derivable
  routes      fallback activations (from→to, reason), route_serving
              switches, and turn errors grouped by ProviderError kind

  --project   another project's slug (default: the current project)
  --days      only sessions modified within the last N days
  --json      machine-readable JSON
  --cwd       project root (default: process.cwd())`;

type Report = ReturnType<typeof aggregateTelemetry>;

interface Collected {
  report: Report;
  sub: "tools" | "routes" | undefined;
  json: boolean;
}

/** Shared filter parsing + aggregation for the three sub-reports. Returns
 * either the parse result or an exit code (2 = usage error). */
function collect(argv: string[], home: string | undefined, err: { write(s: string): void }): Collected | number {
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
  const positionals = parsed.positionals;
  if (positionals.length > 1 || (positionals[0] !== undefined && !["tools", "routes"].includes(positionals[0]!))) {
    err.write(`moh usage: unexpected argument "${positionals[0]}"\n\n${USAGE_USAGE}\n`);
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
  return { report, sub: positionals[0] as Collected["sub"], json: Boolean(parsed.booleans["json"]) };
}

/** Shared empty state: friendly message, exit 0. */
function emptyState(report: Report, err: { write(s: string): void }): number {
  err.write("No sessions found for this project — nothing to report yet.\n");
  if (report.sessionsSkipped > 0) {
    err.write(`${report.sessionsSkipped} unreadable session file(s) skipped.\n`);
  }
  return 0;
}

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
  const collected = collect(argv, home, err);
  if (typeof collected === "number") return collected;
  const { report, sub, json } = collected;
  if (sub === "tools") return renderTools(report, json, out, err);
  if (sub === "routes") return renderRoutes(report, json, out, err);
  return renderModels(report, json, out, err);
}

// ── Shared table rendering ──────────────────────────────────────────────

/** Renders a left-aligned table with a rule under the header; the caller
 * owns the blank-line rhythm. */
function table(header: string[], body: string[][]): string {
  const rows = [header, ...body];
  const widths = header.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return (
    rows
      .map(
        (row, i) =>
          `  ${row.map((cell, c) => cell + " ".repeat(widths[c]! - cell.length)).join("  ").trimEnd()}\n` +
          (i === 0 ? `  ${widths.map((w) => "─".repeat(w)).join("  ")}\n` : ""),
      )
      .join("")
  );
}

const num = (n: number): string => n.toLocaleString("en-US");

function skipNotice(report: Report, err: { write(s: string): void }): void {
  if (report.sessionsSkipped > 0) {
    err.write(`${report.sessionsSkipped} unreadable session file(s) skipped.\n`);
  }
}

// ── Default: per-model usage (#715) ─────────────────────────────────────

function renderModels(report: Report, json: boolean, out: { write(s: string): void }, err: { write(s: string): void }): number {
  const totals = report.models.reduce(
    (acc, m) => ({
      calls: acc.calls + m.calls,
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );

  if (json) {
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
    // Friendly empty state, also for a slug with only unreadable files —
    // the skip notice rides along so the silence is never unexplained.
    return emptyState(report, err);
  }

  const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));
  const rows: string[][] = [
    ["Model", "Calls", "Input tok", "Output tok"],
    ...report.models.map((m) => [m.model, num(m.calls), num(m.inputTokens), num(m.outputTokens)]),
  ];
  const widths = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => r[c]!.length)));
  out.write("Usage by model:\n\n");
  for (const [i, row] of rows.entries()) {
    out.write(
      `  ${pad(row[0]!, widths[0]!)}  ${pad(row[1]!, widths[1]!)}  ${pad(row[2]!, widths[2]!)}  ${row[3]!}\n` +
        (i === 0 ? `  ${"─".repeat(widths[0]!)}  ${"─".repeat(widths[1]!)}  ${"─".repeat(widths[2]!)}  ${"─".repeat(widths[3]!)}\n` : ""),
    );
  }
  out.write(
    `\n  ${report.sessionsScanned} session${report.sessionsScanned === 1 ? "" : "s"}, ` +
      `${num(totals.calls)} call${totals.calls === 1 ? "" : "s"}, ` +
      `${num(totals.inputTokens)} in / ${num(totals.outputTokens)} out tokens\n`,
  );
  skipNotice(report, err);
  return 0;
}

// ── moh usage tools (#716) ──────────────────────────────────────────────

/** Average derivable duration per tool, in ms; null when no paired
 * call→result exists. */
function avgDurationMs(t: Report["tools"][number]): number | null {
  return t.ok + t.fail > 0 ? Math.round(t.totalDurationMs / (t.ok + t.fail)) : null;
}

function renderTools(report: Report, json: boolean, out: { write(s: string): void }, err: { write(s: string): void }): number {
  if (json) {
    out.write(
      JSON.stringify(
        {
          tools: report.tools.map((t) => {
            const avg = avgDurationMs(t);
            return {
              tool: t.tool,
              calls: t.calls,
              ok: t.ok,
              fail: t.fail,
              timeouts: t.timeouts,
              ...(avg !== null ? { avgDurationMs: avg } : {}),
            };
          }),
          sessionsScanned: report.sessionsScanned,
          sessionsSkipped: report.sessionsSkipped,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  if (report.sessionsScanned === 0) return emptyState(report, err);

  const pct = (part: number, whole: number): string => (whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`);
  const rows: string[][] = [
    ["Tool", "Calls", "Ok", "Fail", "Timeouts", "Avg dur"],
    ...report.tools.map((t) => {
      const avg = avgDurationMs(t);
      return [t.tool, num(t.calls), pct(t.ok, t.calls), pct(t.fail, t.calls), num(t.timeouts), avg !== null ? `${num(avg)}ms` : "—"];
    }),
  ];
  out.write("Tool statistics:\n\n");
  if (report.tools.length === 0) {
    out.write("  (no tool calls in the scanned sessions)\n");
  } else {
    out.write(table(rows[0]!, rows.slice(1)));
  }
  out.write(`\n  ${report.sessionsScanned} session${report.sessionsScanned === 1 ? "" : "s"} scanned\n`);
  skipNotice(report, err);
  return 0;
}

// ── moh usage routes (#716) ─────────────────────────────────────────────

function renderRoutes(report: Report, json: boolean, out: { write(s: string): void }, err: { write(s: string): void }): number {
  if (json) {
    out.write(
      JSON.stringify(
        { route: report.route, sessionsScanned: report.sessionsScanned, sessionsSkipped: report.sessionsSkipped },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  if (report.sessionsScanned === 0) return emptyState(report, err);

  out.write("Route health:\n\n");
  if (report.route.fallbacks.length > 0) {
    out.write("Fallback activations:\n\n");
    out.write(
      table(
        ["From", "To", "Reason", "Count"],
        report.route.fallbacks.map((f) => [f.from, f.to, f.reason, num(f.count)]),
      ),
    );
    out.write("\n");
  } else {
    out.write("No fallback activations.\n\n");
  }
  if (report.route.routeServing.length > 0) {
    out.write("Route serving switches:\n\n");
    out.write(
      table(
        ["Selected", "Serving", "Previous", "Count"],
        report.route.routeServing.map((r) => [r.selected, r.serving, r.previous, num(r.count)]),
      ),
    );
    out.write("\n");
  } else {
    out.write("No route_serving switches.\n\n");
  }
  const errorRows = Object.entries(report.route.turnErrors).sort((a, b) => b[1] - a[1]);
  if (errorRows.length > 0) {
    out.write("Turn errors by kind:\n\n");
    out.write(table(["Error kind", "Count"], errorRows.map(([kind, count]) => [kind, num(count)])));
    out.write("\n");
  } else {
    out.write("No turn errors.\n");
  }
  out.write(`\n  ${report.sessionsScanned} session${report.sessionsScanned === 1 ? "" : "s"} scanned\n`);
  skipNotice(report, err);
  return 0;
}
