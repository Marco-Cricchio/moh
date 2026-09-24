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
import { writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { aggregateTelemetry, billingPlanResolver, loadMergedConfig, PRICING_SNAPSHOT } from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const USAGE_USAGE = `usage: moh usage [tools|routes|export] [--format csv|jsonl] [--out <path>] [--project <slug>] [--days <N>] [--json] [--cwd <dir>]

Telemetry sub-reports over the project's local sessions (default: per-model
usage). Metadata only; failed model calls are excluded (they consumed
nothing measurable). Estimated USD is release-pinned approximate pricing;
models without a price record remain tokens-only.

  (default)   per-model usage: model calls, input and output tokens
  tools       per-tool calls, ok/fail rate, timeouts, average call→result
              duration where derivable; failed results with a structured
              errorKind are broken down per reason
  routes      fallback activations (from→to, reason), route_serving
              switches, and turn errors grouped by ProviderError kind

  export      redacted metadata-only export (CSV or JSONL) of the aggregate
              telemetry — per-model usage, per-tool stats, per-session
              rollups. No message content, tool outputs, or reasoning is
              ever included: everything is redacted by construction.
  --format    export format: csv (long "section,entity,metric,value" rows)
              or jsonl (one record per line). Required with export.
  --out       write the export to a path (default: stdout)
  --project   another project's slug (default: the current project)
  --days      only sessions modified within the last N days
  --json      machine-readable JSON
  --cwd       project root (default: process.cwd())`;

type Report = ReturnType<typeof aggregateTelemetry>;

/** Resolves `--cwd` to an absolute project root (siblings like trash.ts
 * and compact.ts resolve too, so a relative `--cwd` never breaks
 * downstream absolute-path checks). */
function resolveCwd(cwdFlag: string | undefined): string {
  const raw = cwdFlag ? cwdFlag : process.cwd();
  return isAbsolute(raw) ? raw : resolve(raw);
}

/** Shared `--days` parsing for every sub-report: returns the since-epoch
 * ms or an exit code (2 = usage error). */
function resolveWindow(
  parsed: { strings: Record<string, string | undefined> },
  prefix: string,
  err: { write(s: string): void },
): { sinceMs?: number } | number {
  const daysRaw = parsed.strings["days"];
  if (daysRaw === undefined) return {};
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
    err.write(`${prefix}: --days expects a positive whole number of days\n`);
    return 2;
  }
  return { sinceMs: Date.now() - days * 24 * 60 * 60 * 1000 };
}

interface Collected {
  report: Report;
  sub: "tools" | "routes" | undefined;
  json: boolean;
}

/** Shared filter parsing + aggregation for the sub-reports. Returns
 * either the parse result or an exit code (2 = usage error). */
function collect(
  argv: string[],
  home: string | undefined,
  err: { write(s: string): void },
): Collected | number | "export" {
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
  const positionals = parsed.positionals;
  if (positionals[0] === "export") {
    if (positionals.length > 1) {
      err.write(`moh usage export: unexpected argument "${positionals[1]}"\n\n${USAGE_USAGE}\n`);
      return 2;
    }
    return "export";
  }
  if (positionals.length > 1 || (positionals[0] !== undefined && !["tools", "routes"].includes(positionals[0]!))) {
    err.write(`moh usage: unexpected argument "${positionals[0]}"\n\n${USAGE_USAGE}\n`);
    return 2;
  }
  const window = resolveWindow(parsed, "moh usage", err);
  if (typeof window === "number") return window;
  const cwd = resolveCwd(parsed.strings["cwd"]);
  const effectiveHome = home ?? homedir();
  const report = aggregateTelemetry({
    cwd,
    home: effectiveHome,
    ...(parsed.strings["project"] ? { slug: parsed.strings["project"] } : {}),
    ...(window.sinceMs !== undefined ? { sinceMs: window.sinceMs } : {}),
    // ADR-0046 billing plan: the estimates use the entry each endpoint pays
    // by. A config that does not read is not an error here — the default
    // plan (metered) is what every surface showed before the plan existed.
    planFor: billingPlanResolver(readEndpoints(cwd, effectiveHome)),
  });
  return { report, sub: positionals[0] as Collected["sub"], json: Boolean(parsed.booleans["json"]) };
}

/** The configured endpoints, or none when the config cannot be read. */
function readEndpoints(cwd: string, home: string): ReturnType<typeof loadMergedConfig>["endpoints"] {
  try {
    return loadMergedConfig(cwd, { home }).endpoints;
  } catch {
    return undefined;
  }
}

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
  if (collected === "export") return exportCommand(argv, home, out, err);
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
const formatUsd = (usd: number): string => `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;

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
      estimatedCostUsd: acc.estimatedCostUsd + (m.estimatedCostUsd ?? 0),
      pricedModels: acc.pricedModels + (m.estimatedCostUsd !== undefined ? 1 : 0),
      unpricedModels: acc.unpricedModels + (m.estimatedCostUsd === undefined ? 1 : 0),
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, pricedModels: 0, unpricedModels: 0 },
  );

  if (json) {
    out.write(
      JSON.stringify(
        {
          models: report.models.map(({ model, calls, inputTokens, outputTokens, estimatedCostUsd }) => ({
            model,
            calls,
            inputTokens,
            outputTokens,
            ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
          })),
          totals: {
            calls: totals.calls,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            ...(totals.pricedModels > 0 ? { estimatedCostUsd: totals.estimatedCostUsd } : {}),
          },
          pricing: { estimate: true, ...PRICING_SNAPSHOT, pricedModels: totals.pricedModels, unpricedModels: totals.unpricedModels },
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
    ["Model", "Calls", "Input tok", "Output tok", "Est. USD"],
    ...report.models.map((m) => [m.model, num(m.calls), num(m.inputTokens), num(m.outputTokens), m.estimatedCostUsd === undefined ? "—" : formatUsd(m.estimatedCostUsd)]),
  ];
  const widths = [0, 1, 2, 3, 4].map((c) => Math.max(...rows.map((r) => r[c]!.length)));
  out.write(`Usage by model (estimated USD; pricing snapshot ${PRICING_SNAPSHOT.version}):\n\n`);
  for (const [i, row] of rows.entries()) {
    out.write(
      `  ${pad(row[0]!, widths[0]!)}  ${pad(row[1]!, widths[1]!)}  ${pad(row[2]!, widths[2]!)}  ${pad(row[3]!, widths[3]!)}  ${row[4]!}\n` +
        (i === 0 ? `  ${"─".repeat(widths[0]!)}  ${"─".repeat(widths[1]!)}  ${"─".repeat(widths[2]!)}  ${"─".repeat(widths[3]!)}  ${"─".repeat(widths[4]!)}\n` : ""),
    );
  }
  out.write(
    `\n  ${report.sessionsScanned} session${report.sessionsScanned === 1 ? "" : "s"}, ` +
      `${num(totals.calls)} call${totals.calls === 1 ? "" : "s"}, ` +
      `${num(totals.inputTokens)} in / ${num(totals.outputTokens)} out tokens` +
      (totals.pricedModels > 0
        ? ` · est. ${formatUsd(totals.estimatedCostUsd)}${totals.unpricedModels > 0 ? ` (partial; ${totals.unpricedModels} model${totals.unpricedModels === 1 ? "" : "s"} unpriced)` : ""}`
        : "") + "\n",
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
              ...(t.errorKinds && Object.keys(t.errorKinds).length > 0 ? { errorKinds: t.errorKinds } : {}),
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
    // #731: structured failure break-down — only kinds the new event field
    // carries; older session logs have no errorKind and stay unclassified.
    const kindRows = report.tools
      .filter((t) => t.errorKinds && Object.keys(t.errorKinds).length > 0)
      .map((t) => {
        const kinds = Object.entries(t.errorKinds!).sort((a, b) => b[1] - a[1]);
        const total = kinds.reduce((s, [, n]) => s + n, 0);
        const summary = kinds.map(([k, n]) => `${k} ${n}`).join(", ");
        return ["  ", t.tool, `${total}/${t.fail} classified`, summary];
      });
    if (kindRows.length > 0) {
      out.write("\nFailure reasons (errorKind, sessions on this moh version):\n");
      for (const [indent, tool, classified, summary] of kindRows) {
        out.write(`${indent}${tool.padEnd(14)} ${classified.padStart(14)}  ${summary}\n`);
      }
    }
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

// ── moh usage export (#717) ─────────────────────────────────────────────

/** Metadata-only export records. No message text, tool argument, tool
 * output, or reasoning is ever exported: those payloads are never read.
 * Identity-ish free text (model ids, subagent names, fallback reasons)
 * is included as-is and CSV-escaped — redact those fields downstream if
 * your dataset policy requires it. */
export type UsageExportRecord =
  | { section: "model"; model: string; calls: number; inputTokens: number; outputTokens: number }
  | { section: "tool"; tool: string; calls: number; ok: number; fail: number; timeouts: number; errorKinds?: Record<string, number> }
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
    records.push({ section: "tool", tool: t.tool, calls: t.calls, ok: t.ok, fail: t.fail, timeouts: t.timeouts, ...(t.errorKinds && Object.keys(t.errorKinds).length > 0 ? { errorKinds: t.errorKinds } : {}) });
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
  argv: string[],
  home: string | undefined,
  out: { write(s: string): void },
  err: { write(s: string): void },
): number {
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
  const formatRaw = parsed.strings["format"];
  if (formatRaw !== "csv" && formatRaw !== "jsonl") {
    err.write(`moh usage export: --format csv|jsonl is required (got ${formatRaw ? `"${formatRaw}"` : "none"})\n\n${USAGE_USAGE}\n`);
    return 2;
  }
  const window = resolveWindow(parsed, "moh usage export", err);
  if (typeof window === "number") return window;
  const cwd = resolveCwd(parsed.strings["cwd"]);
  const effectiveHome = home ?? homedir();
  const report = aggregateTelemetry({
    cwd,
    home: effectiveHome,
    ...(parsed.strings["project"] ? { slug: parsed.strings["project"] } : {}),
    ...(window.sinceMs !== undefined ? { sinceMs: window.sinceMs } : {}),
    // ADR-0046 billing plan: the estimates use the entry each endpoint pays
    // by. A config that does not read is not an error here — the default
    // plan (metered) is what every surface showed before the plan existed.
    planFor: billingPlanResolver(readEndpoints(cwd, effectiveHome)),
  });
  if (report.sessionsScanned === 0) return emptyState(report, err);

  const body = renderExport(report, formatRaw);
  const outPath = parsed.strings["out"];
  if (outPath) {
    // Relative --out anchors to the aggregation root (the resolved
    // --cwd); a `..` traversal out of it is refused. Absolute paths are
    // the caller's explicit choice and are taken as-is (no symlink-based
    // containment guess).
    const root = resolveCwd(parsed.strings["cwd"]);
    const target = isAbsolute(outPath) ? outPath : resolve(root, outPath);
    if (!isAbsolute(outPath) && relative(root, target).startsWith("..")) {
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
