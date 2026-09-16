/**
 * `moh usage` (#715): a thin projection over the core multi-session
 * telemetry aggregator (#714) — per-model usage (calls, input/output
 * tokens) across the project's local session files, with `--project`,
 * `--days` (session mtime window) and `--json` filters. Metadata only,
 * all local; no sessions → friendly empty message, never an error.
 */
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { aggregateTelemetry } from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const USAGE_USAGE = `usage: moh usage [export] [--format csv|jsonl] [--out <path>] [--project <slug>] [--days <N>] [--json] [--cwd <dir>]

Per-model usage report across the project's local sessions: model calls,
input and output tokens summed over every session file. Failed calls are
excluded (they consumed nothing measurable).

  export      redacted metadata-only export (CSV or JSONL) of the aggregate
              telemetry — per-model usage, per-tool stats, per-session
              rollups. No message content, tool outputs, or reasoning is
              ever included: everything is redacted by construction.
  --format    export format: csv (long "section,entity,metric,value" rows)
              or jsonl (one record per line). Required with export.
  --out       write the export to a path (default: stdout)
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
    parsed = parseArgs(argv, { strings: ["project", "days", "cwd", "format", "out"], booleans: ["json"] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh usage: ${e.message}\n\n${USAGE_USAGE}\n`);
      return 2;
    }
    throw e;
  }
  if (parsed.positionals.length) {
    if (parsed.positionals[0] === "export") {
      if (parsed.positionals.length > 1) {
        err.write(`moh usage export: unexpected argument "${parsed.positionals[1]}"\n\n${USAGE_USAGE}\n`);
        return 2;
      }
      return exportCommand(parsed, home, out, err);
    }
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

  const totals = report.models.reduce(
    (acc, m) => ({
      calls: acc.calls + m.calls,
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );

  if (parsed.booleans["json"]) {
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

  const num = (n: number): string => n.toLocaleString("en-US");

  if (report.sessionsScanned === 0) {
    // Friendly empty state, also for a slug with only unreadable files —
    // the skip notice rides along so the silence is never unexplained.
    err.write("No sessions found for this project — nothing to report yet.\n");
    if (report.sessionsSkipped > 0) {
      err.write(`${report.sessionsSkipped} unreadable session file(s) skipped.\n`);
    }
    return 0;
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
  if (report.sessionsSkipped > 0) {
    err.write(`${report.sessionsSkipped} unreadable session file(s) skipped.\n`);
  }
  return 0;
}

// ── moh usage export (#717) ─────────────────────────────────────────────

/** Metadata-only export records. By construction no message content,
 * tool output, or reasoning can appear: every field below comes from the
 * aggregator's counters, never from an event payload string. */
export type UsageExportRecord =
  | { section: "model"; model: string; calls: number; inputTokens: number; outputTokens: number }
  | { section: "tool"; tool: string; calls: number; ok: number; fail: number; timeouts: number }
  | { section: "route_fallback"; from: string; to: string; reason: string; count: number }
  | { section: "route_serving"; selected: string; serving: string; previous: string; count: number }
  | { section: "turn_error"; kind: string; count: number }
  | {
      section: "session";
      id: string;
      done: number;
      error: number;
      cancelled: number;
      inputTokens: number;
      outputTokens: number;
      modelsServed: string[];
      durationMs: number;
      subagents: { name: string; status: string; calls: number; inputTokens: number; outputTokens: number }[];
    }
  | { section: "meta"; sessionsScanned: number; sessionsSkipped: number };

/** Flattens the aggregate report into ordered export records. */
export function exportRecords(report: ReturnType<typeof aggregateTelemetry>): UsageExportRecord[] {
  const records: UsageExportRecord[] = report.models.map((m) => ({
    section: "model",
    model: m.model,
    calls: m.calls,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
  }));
  for (const t of report.tools) {
    records.push({ section: "tool", tool: t.tool, calls: t.calls, ok: t.ok, fail: t.fail, timeouts: t.timeouts });
  }
  for (const f of report.route.fallbacks) {
    records.push({ section: "route_fallback", from: f.from, to: f.to, reason: f.reason, count: f.count });
  }
  for (const r of report.route.routeServing) {
    records.push({ section: "route_serving", selected: r.selected, serving: r.serving, previous: r.previous, count: r.count });
  }
  for (const [kind, count] of Object.entries(report.route.turnErrors)) {
    records.push({ section: "turn_error", kind, count });
  }
  for (const s of report.sessions) {
    records.push({
      section: "session",
      id: s.id,
      done: s.turns.done,
      error: s.turns.error,
      cancelled: s.turns.cancelled,
      inputTokens: s.tokens.inputTokens,
      outputTokens: s.tokens.outputTokens,
      modelsServed: s.modelsServed,
      durationMs: s.durationMs,
      subagents: s.subagents.map((sub) => ({
        name: sub.name,
        status: sub.status,
        calls: sub.calls,
        inputTokens: sub.inputTokens,
        outputTokens: sub.outputTokens,
      })),
    });
  }
  records.push({ section: "meta", sessionsScanned: report.sessionsScanned, sessionsSkipped: report.sessionsSkipped });
  return records;
}

const CSV_HEADER = "section,entity,metric,value";

/** Shared empty state: friendly message, exit 0. */
function emptyState(report: { sessionsSkipped: number }, err: { write(s: string): void }): number {
  err.write("No sessions found for this project — nothing to report yet.\n");
  if (report.sessionsSkipped > 0) err.write(`${report.sessionsSkipped} unreadable session file(s) skipped.\n`);
  return 0;
}

/** RFC-4180 quoting: quote when the value contains a comma, quote,
 * or newline; double embedded quotes. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvRow(cells: (string | number)[]): string {
  return cells.map((c) => csvField(String(c))).join(",");
}

/** One long row per scalar fact: `section,entity,metric,value`. */
function recordToCsvRows(record: UsageExportRecord): string[] {
  const rows: string[] = [];
  const push = (entity: string, metric: string, value: string | number) => rows.push(csvRow([record.section, entity, metric, value]));
  if (record.section === "session") {
    push(record.id, "turns.done", record.done);
    push(record.id, "turns.error", record.error);
    push(record.id, "turns.cancelled", record.cancelled);
    push(record.id, "tokens.input", record.inputTokens);
    push(record.id, "tokens.output", record.outputTokens);
    push(record.id, "durationMs", record.durationMs);
    push(record.id, "modelsServed", record.modelsServed.join("|"));
    for (const sub of record.subagents) {
      push(`${record.id}/${sub.name}`, "subagent.calls", sub.calls);
      push(`${record.id}/${sub.name}`, "subagent.tokens.in", sub.inputTokens);
      push(`${record.id}/${sub.name}`, "subagent.tokens.out", sub.outputTokens);
      push(`${record.id}/${sub.name}`, "subagent.status", sub.status);
    }
    return rows;
  }
  if (record.section === "meta") {
    push("report", "sessionsScanned", record.sessionsScanned);
    push("report", "sessionsSkipped", record.sessionsSkipped);
    return rows;
  }
  const entity =
    record.section === "model"
      ? record.model
      : record.section === "tool"
        ? record.tool
        : record.section === "route_fallback"
          ? `${record.from} -> ${record.to} (${record.reason})`
          : record.section === "route_serving"
            ? `${record.selected} -> ${record.serving} (prev ${record.previous})`
            : record.kind;
  if (record.section === "model") {
    push(entity, "calls", record.calls);
    push(entity, "inputTokens", record.inputTokens);
    push(entity, "outputTokens", record.outputTokens);
  } else if (record.section === "tool") {
    push(entity, "calls", record.calls);
    push(entity, "ok", record.ok);
    push(entity, "fail", record.fail);
    push(entity, "timeouts", record.timeouts);
  } else {
    push(entity, "count", record.count);
  }
  return rows;
}

function renderExport(
  report: ReturnType<typeof aggregateTelemetry>,
  format: "csv" | "jsonl",
): string {
  const records = exportRecords(report);
  if (format === "jsonl") return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  return [CSV_HEADER, ...records.flatMap(recordToCsvRows)].join("\n") + "\n";
}

function exportCommand(
  parsed: { strings: Record<string, string | undefined>; booleans: Record<string, boolean | undefined> },
  home: string | undefined,
  out: { write(s: string): void },
  err: { write(s: string): void },
): number {
  const formatRaw = parsed.strings["format"];
  if (formatRaw !== "csv" && formatRaw !== "jsonl") {
    err.write(`moh usage export: --format csv|jsonl is required (got ${formatRaw ? `"${formatRaw}"` : "none"})\n\n${USAGE_USAGE}\n`);
    return 2;
  }
  const daysRaw = parsed.strings["days"];
  let sinceMs: number | undefined;
  if (daysRaw !== undefined) {
    const days = Number(daysRaw);
    if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
      err.write(`moh usage export: --days expects a positive whole number of days\n`);
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
  if (report.sessionsScanned === 0) return emptyState(report, err);

  const body = renderExport(report, formatRaw);
  const outPath = parsed.strings["out"];
  if (outPath) {
    const target = isAbsolute(outPath) ? outPath : resolve(cwd, outPath);
    if (!isAbsolute(outPath) && !target.startsWith(cwd + (cwd.endsWith("/") ? "" : "/"))) {
      err.write(`moh usage export: --out must be an absolute path or relative to the project root\n`);
      return 2;
    }
    writeFileSync(target, body);
    err.write(`Export written to ${target}\n`);
  } else {
    out.write(body);
  }
  return 0;
}
