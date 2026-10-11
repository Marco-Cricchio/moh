import React, { useEffect, useState } from "react";
import { Text, useInput } from "ink";
import { getQuota, aggregateLocalUsage, PRICING_SNAPSHOT, type QuotaReport, type QuotaSource, type LocalUsageRow } from "@moh/core";
import type { EndpointProfile } from "@moh/core";
import Table from "cli-table3";
import { fgAnsi256 } from "./color";
import { useTheme } from "./themes";
import { Dialog, Dim, formatCount } from "./ui";
import { useViewport } from "./viewport";
import { SPINNER_FRAMES } from "./icons";

/**
 * The usage quota modal (#499): opened with ctrl+q from chat. Probes the
 * session's endpoints on open (60s in-memory cache, `r` forces refresh),
 * renders one table per endpoint with a cell per quota window (bar and
 * source badge ● documented / ○ undocumented), plus the always-present
 * local section as fixed-column tables (model | in | out | calls | est.
 * USD) with a total row. A remote failure degrades to the local section
 * with a discreet note — never an error.
 */
export interface QuotaModalProps {
  /** The session's merged endpoint profiles (`session.endpointProfiles`). */
  endpoints: EndpointProfile[];
  /** Local measured usage: per-model rows from the open session's events. */
  localUsage: LocalUsageRow[];
  /** #718: per-model rollup over the last N project sessions (bounded
   * `aggregateTelemetry` read, computed by the caller on open). When
   * provided, the local section grows a "last N sessions" block; absent
   * or failed, the modal degrades to the session-only view. */
  recentUsage?: { window: number; models: LocalUsageRow[] } | null;
  /** Probe seam (defaults to the core `getQuota`; tests inject fixtures). */
  probe?: (endpoint: EndpointProfile) => Promise<QuotaReport | null>;
  onClose: () => void;
}

type ReportState = Record<string, QuotaReport | null | "loading">;

/** Cache TTL for probe results (issue decision: 60s, on-open only). */
const CACHE_TTL_MS = 60_000;

/** OpenCode exposes account usage in the Console, not a probeable quota API. */
export const OPENCODE_CONSOLE_URL = "https://opencode.ai/console";

function isOpenCodeEndpoint(endpoint: EndpointProfile): boolean {
  return endpoint.type === "opencode";
}

const moduleCache = new Map<string, { at: number; report: QuotaReport | null }>();

/** Cache key: name + identity, so a re-pointed endpoint never serves
 * stale numbers under the same name. */
function cacheKey(e: EndpointProfile): string {
  return `${e.name}|${e.type}|${e.baseUrl ?? ""}|${e.apiKey ? "key" : e.auth?.kind ?? "none"}`;
}

export function clearQuotaCache(): void {
  moduleCache.clear();
}

export function QuotaModal({ endpoints, localUsage, recentUsage, probe, onClose }: QuotaModalProps) {
  const theme = useTheme();
  const [reports, setReports] = useState<ReportState>({});
  const [tick, setTick] = useState(0);
  const [nonce, setNonce] = useState(0);

  const probeFn = probe ?? ((e: EndpointProfile) => getQuota(e));

  useEffect(() => {
    let live = true;
    (async () => {
      for (const e of endpoints) {
        if (isOpenCodeEndpoint(e)) continue;
        const key = cacheKey(e);
        const cached = moduleCache.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
          setReports((r) => ({ ...r, [e.name]: cached.report }));
          continue;
        }
        setReports((r) => ({ ...r, [e.name]: "loading" }));
        const report = await probeFn(e).catch(() => null);
        // Only successes are cached: a transient failure must not read as
        // "no quota source" for the whole TTL.
        if (report !== null) moduleCache.set(key, { at: Date.now(), report });
        if (live) setReports((r) => ({ ...r, [e.name]: report }));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, endpoints]);

  // Spinner only while something is in flight.
  const loading = Object.values(reports).some((v) => v === "loading");
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setTick((n) => n + 1), 90);
    return () => clearInterval(t);
  }, [loading]);

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (input === "r") {
      clearQuotaCache();
      setReports({});
      setNonce((n) => n + 1);
    }
  });

  const remoteEndpoints = endpoints.filter((e) => !isOpenCodeEndpoint(e));
  const openCodeEndpoints = endpoints.filter(isOpenCodeEndpoint);
  const probed = remoteEndpoints.filter((e) => reports[e.name] !== undefined);
  const anyUnavailable = probed.some((e) => reports[e.name] === null);
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;

  // Vertical-overflow guarantee: the body is a list of measured blocks
  // (per-endpoint table, notes) windowed to the terminal height, and the
  // local tables cap their data rows to what is left. Tables render as
  // plain (ANSI-colored) strings, so a block's height is its line count.
  const viewport = useViewport();
  const budget = Math.max(4, viewport.rows - 6);

  type Block = { lines: number; node: React.ReactNode };
  const blocks: Block[] = [];
  const loadingRow = probed.length === 0 && loading;
  for (const e of probed) {
    const state = reports[e.name];
    if (state === undefined || state === "loading") {
      blocks.push({ lines: 1, node: <Text key={e.name}><Text bold>{` ${e.name}`}</Text><Dim>{` ${spinner} probing…`}</Dim></Text> });
    } else if (state === null) {
      blocks.push({ lines: 1, node: <Text key={e.name}><Text bold>{` ${e.name}`}</Text><Dim> — no quota source</Dim></Text> });
    } else {
      const table = quotaEndpointTable(e.name, state, theme);
      blocks.push({ lines: state.windows.length + 3, node: <Text key={e.name}>{table}</Text> });
    }
  }
  if (anyUnavailable) blocks.push({ lines: 1, node: <Dim key="unavail"> provider quota unavailable — local measurement only</Dim> });
  if (openCodeEndpoints.length > 0)
    blocks.push({ lines: 1, node: <Dim key="opencode">{` OpenCode usage: ${OPENCODE_CONSOLE_URL} · local measurement below`}</Dim> });

  const fixedLines = (loadingRow ? 1 : 0) + 3; // footer hint + local-table header/note rows
  let remaining = budget - fixedLines;
  const visibleBlocks: React.ReactNode[] = [];
  let localRoom = 0;
  for (const block of blocks) {
    if (remaining <= 0) break;
    const take = Math.min(block.lines, remaining);
    visibleBlocks.push(block.node);
    remaining -= take;
  }
  localRoom = Math.max(0, remaining);
  const hasRecent = recentUsage !== undefined && recentUsage !== null && recentUsage.models.length > 0;
  const recentRows = hasRecent ? recentUsage!.models.length + 3 : 0;
  const recentBudget = hasRecent ? Math.min(recentRows, Math.max(0, Math.floor(localRoom / 2))) : 0;
  const currentBudget = Math.max(0, localRoom - recentBudget);

  return (
    <Dialog title=" usage quota " color={theme.ok}>
      {loadingRow && <Dim>{`${spinner} probing provider quota…`}</Dim>}
      {visibleBlocks}
      <LocalTable
        title="local measured (this session)"
        note={`estimated USD · pricing snapshot ${PRICING_SNAPSHOT.version}`}
        rows={localUsage}
        empty="no model calls yet"
        maxRows={currentBudget - 3}
      />
      {hasRecent ? (
        <LocalTable
          title={`local measured (last ${recentUsage!.window} sessions)`}
          rows={recentUsage!.models}
          maxRows={recentBudget - 2}
        />
      ) : null}
      <Dim> ● documented · ○ provider-reported · r refresh · esc close</Dim>
    </Dialog>
  );
}

/** The endpoint's quota table as a rendered string: the header row carries
 * the endpoint name (plus the source badge); each quota window is a body
 * cell with label, detail, bar and reset. */
function quotaEndpointTable(
  name: string,
  state: QuotaReport,
  theme: { ok?: string; warn?: string; err?: string; dim?: string },
): string {
  const badge = state.source === "official" ? "●" : "○";
  const t = new Table({
    // Runtime supports {content, colSpan} header cells; the type defs
    // only know strings.
    head: [{ content: `${badge} ${name}`, colSpan: 3 } as unknown as string],
    style: { head: [], border: ["grey"] },
    chars: ROUND_CHARS,
  });
  for (const w of state.windows) {
    const fraction = windowFraction(w);
    const detail =
      w.used !== undefined && w.limit !== undefined
        ? `${formatCount(w.used)} / ${formatCount(w.limit)}`
        : w.percent !== undefined
          ? `${Math.round(w.percent)}%`
          : "";
    const reset = w.resetAt !== undefined ? formatReset(w.resetAt) : "";
    const bar = fraction !== undefined ? barCells(BAR_CELLS, fraction) : "";
    const cellColor = fraction === undefined ? "" : `${fg(fractionColor(fraction, theme))}`;
    t.push([
      w.label,
      `${cellColor}${detail}${bar ? ` ${bar}` : ""}${cellColor ? "\x1b[39m" : ""}`,
      `${fg(theme.dim)}${reset}\x1b[39m`,
    ]);
  }
  return cleanTable(t.toString());
}

const BAR_CELLS = 12;

/** Filled/empty bar cell string for a 0..1 fraction. */
function barCells(cells: number, fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * cells);
  return "█".repeat(filled) + "·".repeat(cells - filled);
}

/** Round-border table glyphs (post-processed by cleanTable into the
 * minimal bars-only look, keeping cli-table3's width math intact). */
const ROUND_CHARS = {
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
  left: "│", right: "│", top: "─", bottom: "─", middle: "┼",
  "left-mid": "├", "mid-mid": "┼", "right-mid": "┤",
};

/** Strips cli-table3's pure separator rows (no `│` at all) and flattens
 * every junction in content rows into a plain vertical bar, so tables
 * read as a single rule on top and bottom with continuous column bars
 * between. */
function cleanTable(s: string): string {
  return s
    .split("\n")
    .filter((line) => !/^[^│]*[├┼┤][^│]*$/.test(line))
    .map((line) =>
      line.includes("│")
        ? line.replace(/[├┼┤┬┴]/g, "│")
        : line.replace(/[├┼┤┬┴]/g, "─"),
    )
    .join("\n");
}

interface LocalTableProps {
  title: string;
  note?: string;
  rows: LocalUsageRow[];
  empty?: string;
  /** Vertical-overflow guarantee: at most this many data rows; the rest
   * are cut with a "…N more" marker. Undefined = no cap (tests). */
  maxRows?: number;
}

/** Fixed-column local usage table: model | in | out | calls | est. USD,
 * numbers right-aligned in their cells, colored total row at the foot. */
function LocalTable({ title, note, rows, empty, maxRows }: LocalTableProps) {
  const theme = useTheme();
  const hasCost = rows.some((r) => r.estimatedCostUsd !== undefined);
  const total = rows.reduce(
    (a, r) => ({ in: a.in + r.inputTokens, out: a.out + r.outputTokens, calls: a.calls + r.calls, usd: a.usd + (r.estimatedCostUsd ?? 0) }),
    { in: 0, out: 0, calls: 0, usd: 0 },
  );
  const headers = ["model", "in", "out", "calls"];
  if (hasCost) headers.push("est. USD");
  const t = new Table({
    head: headers.map((h) => `${fg(theme.accent)}\x1b[1m${h}\x1b[22m\x1b[39m`),
    style: { head: [], border: ["grey"] },
    chars: ROUND_CHARS,
  });
  const shown = maxRows !== undefined && maxRows >= 0 ? rows.slice(0, maxRows) : rows;
  const cut = rows.length - shown.length;
  for (const r of shown) {
    const cells = [r.model, formatCount(r.inputTokens), formatCount(r.outputTokens), String(r.calls)];
    if (hasCost) cells.push(r.estimatedCostUsd === undefined ? "—" : formatUsd(r.estimatedCostUsd));
    t.push(cells);
  }
  if (rows.length > 0) {
    const totalCells = [
      `${fg(theme.dim)}total\x1b[39m`,
      `${fg(theme.dim)}${formatCount(total.in)}\x1b[39m`,
      `${fg(theme.dim)}${formatCount(total.out)}\x1b[39m`,
      `${fg(theme.dim)}${String(total.calls)}\x1b[39m`,
    ];
    if (hasCost) totalCells.push(`${fg(theme.dim)}${formatUsd(total.usd)}\x1b[39m`);
    t.push(totalCells);
  }
  return (
    <>
      <Text> </Text>
      <Text bold>{` ${title}`}</Text>
      {note !== undefined && <Dim>{` ${note}`}</Dim>}
      {rows.length === 0 ? <Dim>{` ${empty ?? ""}`}</Dim> : <Text>{cleanTable(t.toString())}</Text>}
      {cut > 0 && <Dim>{` …and ${cut} more model(s)`}</Dim>}
    </>
  );
}

function windowFraction(w: { percent?: number; used?: number; limit?: number }): number | undefined {
  if (w.percent !== undefined) return w.percent / 100;
  if (w.used !== undefined && w.limit) return w.used / w.limit;
  return undefined;
}

/** #880: table cells are plain strings, so their color comes from the seam
 * (ANSI-256, the approximation cli-table3 can carry) and is `""` — no
 * color — when the terminal must not receive codes. */
const fg = fgAnsi256;

function fractionColor(fraction: number, theme: { ok?: string; warn?: string; err?: string }): string | undefined {
  return fraction > 0.8 ? theme.err : fraction > 0.6 ? theme.warn : theme.ok;
}




function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

function formatReset(at: number): string {
  const diffMs = at - Date.now();
  if (diffMs <= 0) return "now";
  const h = Math.floor(diffMs / 3_600_000);
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24 > 0 ? ` ${h % 24}h` : ""}`;
  if (h >= 1) return `${h}h${Math.floor((diffMs % 3_600_000) / 60_000) > 0 ? ` ${Math.floor((diffMs % 3_600_000) / 60_000)}m` : ""}`;
  return `${Math.max(1, Math.floor(diffMs / 60_000))}m`;
}
