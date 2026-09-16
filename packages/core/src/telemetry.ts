/**
 * #714: the multi-session telemetry aggregator — one read-only projection
 * over the project's session event logs. Metadata only: tokens, call
 * counts, statuses, durations, error kinds — never message content, tool
 * outputs, or reasoning. Everything is local (session files under the
 * project directory); a corrupt or unreadable session file is skipped,
 * never fatal. Per-model usage reuses the exact `aggregateLocalUsage`
 * convention (failed calls excluded) instead of forking the math.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentEvent } from "./types";
import { aggregateLocalUsage, type LocalUsageRow } from "./quota/local";
import { estimateModelCost } from "./pricing";
import { activePath } from "./session/event-log";
import { ENCODING } from "./session/ulid";
import { projectSessionsDir } from "./session-store";

/** Per-model usage across sessions (failed calls excluded), with the
 * thinking levels the model actually served (when audited on the call).
 * Extends `LocalUsageRow` for shape parity with the quota rollup; the
 * optional `lastCallAt` field is never populated here. */
export interface TelemetryModelRow extends LocalUsageRow {
  /** Audited thinking level → call count; absent when no call carried one. */
  thinkingLevels?: Record<string, number>;
}

/** Tool statistics across sessions. */
export interface TelemetryToolRow {
  tool: string;
  calls: number;
  ok: number;
  fail: number;
  /** Results whose output reports a timeout (`<tool>: timed out after …`). */
  timeouts: number;
  /** Sum of call→result event-id (ULID) deltas where both sides exist;
   * the caller derives the average (`totalDurationMs / (ok + fail)`). */
  totalDurationMs: number;
}

/** One route-health bucket: a fallback activation seen `count` times. */
export interface TelemetryFallbackRow {
  from: string;
  to: string;
  reason: string;
  count: number;
}

/** One `route_serving` transition seen `count` times (#363). */
export interface TelemetryRouteServingRow {
  selected: string;
  serving: string;
  previous: string;
  count: number;
}

/** Per-session rollup (metadata only). */
export interface TelemetrySessionRow {
  id: string;
  turns: { done: number; error: number; cancelled: number };
  tokens: { inputTokens: number; outputTokens: number };
  /** Models that served at least one (non-failed) call. */
  modelsServed: string[];
  /** Estimated USD by model where release-pinned pricing is available. */
  estimatedCostUsdByModel: Record<string, number>;
  /** `session_start` → last event, from ULID identity (0 when undatable). */
  durationMs: number;
  /** Subagent usage from `subagent_result` events, grouped per child name. */
  subagents: TelemetrySubagentRow[];
}

export interface TelemetrySubagentRow {
  name: string;
  status: "done" | "error" | "cancelled";
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TelemetryRouteHealth {
  fallbacks: TelemetryFallbackRow[];
  routeServing: TelemetryRouteServingRow[];
  /** Turn `error` events grouped by reason (ProviderError kinds and loop
   * reasons alike — the log does not distinguish). */
  turnErrors: Record<string, number>;
}

export interface TelemetryReport {
  models: TelemetryModelRow[];
  tools: TelemetryToolRow[];
  route: TelemetryRouteHealth;
  sessions: TelemetrySessionRow[];
  /** Session files found (including skipped ones). */
  sessionsScanned: number;
  /** Files skipped as corrupt/unreadable — skipped, never fatal. An
   * empty session file counts here too (nothing to aggregate). */
  sessionsSkipped: number;
}

/** The single wording convention: `<tool>: timed out after <N>ms…`. */
function isTimeoutOutput(output: string): boolean {
  return /: timed out after \d+ms/.test(output);
}

/** ULID time component (first 10 Crockford chars) → epoch ms, or null.
 * Reads the Crockford alphabet directly — the mirror of `encodeTime`. */
function ulidTimeMs(id: string | undefined): number | null {
  if (!id || id.length < 10) return null;
  let ms = 0;
  for (let i = 0; i < 10; i++) {
    const v = ENCODING.indexOf(id[i]!);
    if (v < 0) return null;
    ms = ms * 32 + v;
  }
  return ms;
}

function bumpCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

/** Aggregates one parsed session's events into its rollup, feeding the
 * cross-session accumulators. Runs on the active-path projection, like
 * every other read seam (#577). */
function aggregateSession(events: readonly AgentEvent[]): TelemetrySessionRow {
  const path = activePath([...events]);
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  const turns = { done: 0, error: 0, cancelled: 0 };
  const tokens = { inputTokens: 0, outputTokens: 0 };
  const models = new Set<string>();
  const costs = new Map<string, number>();
  const subagents = new Map<string, TelemetrySubagentRow>();
  for (const event of path) {
    const ms = ulidTimeMs(event.id);
    if (ms !== null) {
      firstMs = firstMs ?? ms;
      lastMs = ms;
    }
    if (event.type === "done" || event.type === "error" || event.type === "cancelled") turns[event.type] += 1;
    if (event.type === "model_call" && !event.failed) {
      tokens.inputTokens += event.usage.inputTokens;
      tokens.outputTokens += event.usage.outputTokens;
      models.add(event.model);
      const estimate = estimateModelCost(event.model, event.usage);
      if (estimate) costs.set(event.model, (costs.get(event.model) ?? 0) + estimate.usd);
    }
    if (event.type === "subagent_result") {
      const row = subagents.get(event.name) ?? {
        name: event.name,
        status: event.status,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      row.calls += 1;
      row.status = event.status;
      row.inputTokens += event.usage.inputTokens;
      row.outputTokens += event.usage.outputTokens;
      subagents.set(event.name, row);
    }
  }
  return {
    id: "",
    turns,
    tokens,
    modelsServed: [...models].sort(),
    estimatedCostUsdByModel: Object.fromEntries(costs),
    durationMs: firstMs !== null && lastMs !== null ? Math.max(0, lastMs - firstMs) : 0,
    subagents: [...subagents.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Reads every session file under the project directory (same resolution
 * as `SessionStore.list` — the uuid-declared slug when a project identity
 * exists, else the legacy path-derived slug) and produces one aggregate
 * telemetry report. Read-only; corrupt files are skipped and counted in
 * `sessionsSkipped`.
 */
export function aggregateTelemetry(options: {
  cwd: string;
  home?: string;
  /** Explicit project slug override (`moh usage --project <slug>`); the
   * default resolves the slug from `cwd` like `SessionStore.list`. */
  slug?: string;
  /** Drop session files whose mtime is older than this epoch ms
   * (`moh usage --days <N>`); filtered before any parsing. */
  sinceMs?: number;
  /** Keep only the N most recent session files (by mtime) — the bounded
   * read behind the TUI's "last N sessions" views; filtered before any
   * parsing, same policy as `sinceMs` (dropped files are not scanned). */
  maxSessions?: number;
}): TelemetryReport {
  const dir = projectSessionsDir(options.cwd, options.home, options.slug);
  const report: TelemetryReport = {
    models: [],
    tools: [],
    route: { fallbacks: [], routeServing: [], turnErrors: {} },
    sessions: [],
    sessionsScanned: 0,
    sessionsSkipped: 0,
  };
  if (!existsSync(dir)) return report;

  const modelRows = new Map<string, TelemetryModelRow>();
  const toolRows = new Map<string, TelemetryToolRow>();
  const fallbacks = new Map<string, TelemetryFallbackRow>();
  const routeServing = new Map<string, TelemetryRouteServingRow>();

  const jsonl = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  // Bounded read: newest-N by mtime, stat before any parsing. Files whose
  // stat fails are dropped here (counted skipped) — the readdir order is
  // otherwise preserved for determinism below.
  let names = jsonl;
  if (options.maxSessions !== undefined && jsonl.length > options.maxSessions) {
    const mtimes = new Map<string, number>();
    for (const name of jsonl) {
      try {
        mtimes.set(name, statSync(join(dir, name)).mtimeMs);
      } catch {
        report.sessionsSkipped += 1;
      }
    }
    names = jsonl
      .filter((name) => mtimes.has(name))
      .sort((a, b) => mtimes.get(b)! - mtimes.get(a)!)
      .slice(0, options.maxSessions);
  }

  for (const name of names) {
    if (options.sinceMs !== undefined) {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(dir, name)).mtimeMs;
      } catch {
        report.sessionsSkipped += 1;
        continue;
      }
      if (mtimeMs < options.sinceMs) continue;
    }
    report.sessionsScanned += 1;
    let events: AgentEvent[];
    try {
      events = readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as AgentEvent);
    } catch {
      report.sessionsSkipped += 1;
      continue;
    }
    if (events.length === 0) {
      report.sessionsSkipped += 1;
      continue;
    }

    // Per-model usage: the existing local rollup, then enriched with the
    // audited thinking levels. Same math, no fork.
    for (const row of aggregateLocalUsage(events)) {
      const acc = modelRows.get(row.model) ?? { model: row.model, calls: 0, inputTokens: 0, outputTokens: 0, thinkingLevels: {} };
      acc.calls += row.calls;
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      if (row.estimatedCostUsd !== undefined) acc.estimatedCostUsd = (acc.estimatedCostUsd ?? 0) + row.estimatedCostUsd;
      modelRows.set(row.model, acc);
    }

    const rollup = aggregateSession(events);
    rollup.id = basename(name, ".jsonl");
    report.sessions.push(rollup);

    // Tool pairing: callId → tool name + call time, one pass (never
    // events.find per result — O(n²) on large logs).
    const callByCallId = new Map<string, { name: string; ms: number | null }>();
    for (const event of events) {
      if (event.type === "tool_call") callByCallId.set(event.callId, { name: event.name, ms: ulidTimeMs(event.id) });
    }

    // Cross-session aggregates (models, tools, route, errors) run on the
    // raw file order — an abandoned-branch turn still counts as usage —
    // while per-session rollups project the active path (same read seam
    // as replay). Both are metadata counts; neither rewrites the log.
    for (const event of events) {
      if (event.type === "model_call" && !event.failed && event.thinkingLevel !== undefined) {
        const acc = modelRows.get(event.model);
        if (acc) bumpCount(acc.thinkingLevels!, event.thinkingLevel);
      }
      if (event.type === "tool_call") {
        const acc = toolRows.get(event.name) ?? { tool: event.name, calls: 0, ok: 0, fail: 0, timeouts: 0, totalDurationMs: 0 };
        acc.calls += 1;
        toolRows.set(event.name, acc);
      }
      if (event.type === "tool_result") {
        const call = callByCallId.get(event.callId);
        const acc = call ? toolRows.get(call.name) : undefined;
        if (acc) {
          if (event.ok) acc.ok += 1;
          else acc.fail += 1;
          if (!event.ok && isTimeoutOutput(event.output)) acc.timeouts += 1;
          const resultMs = ulidTimeMs(event.id);
          if (call?.ms !== null && call?.ms !== undefined && resultMs !== null) {
            acc.totalDurationMs += Math.max(0, resultMs - call.ms);
          }
        }
      }
      if (event.type === "fallback") {
        const key = `${event.from}→${event.to}:${event.reason}`;
        const acc = fallbacks.get(key) ?? { from: event.from, to: event.to, reason: event.reason, count: 0 };
        acc.count += 1;
        fallbacks.set(key, acc);
      }
      if (event.type === "route_serving") {
        const key = `${event.selected}→${event.serving}:${event.previous}`;
        const acc = routeServing.get(key) ?? {
          selected: event.selected,
          serving: event.serving,
          previous: event.previous,
          count: 0,
        };
        acc.count += 1;
        routeServing.set(key, acc);
      }
      if (event.type === "error") bumpCount(report.route.turnErrors, event.reason);
    }
  }

  report.models = [...modelRows.values()]
    .map((row) => ({
      model: row.model,
      calls: row.calls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      ...(row.estimatedCostUsd !== undefined ? { estimatedCostUsd: row.estimatedCostUsd } : {}),
      ...(Object.keys(row.thinkingLevels!).length > 0 ? { thinkingLevels: row.thinkingLevels } : {}),
    }))
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  report.tools = [...toolRows.values()].sort((a, b) => b.calls - a.calls);
  report.route.fallbacks = [...fallbacks.values()].sort((a, b) => b.count - a.count);
  report.route.routeServing = [...routeServing.values()].sort((a, b) => b.count - a.count);
  report.sessions.sort((a, b) => a.id.localeCompare(b.id));
  return report;
}
