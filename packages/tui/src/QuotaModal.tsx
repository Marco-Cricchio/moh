import React, { useEffect, useState } from "react";
import { Text, useInput } from "ink";
import { getQuota, aggregateLocalUsage, type QuotaReport, type LocalUsageRow } from "@moh/core";
import type { EndpointProfile } from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim, truncate } from "./ui";
import { SPINNER_FRAMES } from "./icons";

/**
 * The usage quota modal (#499): opened with ctrl+q from chat. Probes the
 * session's endpoints on open (60s in-memory cache, `r` forces refresh),
 * renders one row per quota window with a progress bar and a source badge
 * (● documented / ○ undocumented), plus the always-present local section
 * (session tokens per model from the event log). A remote failure degrades
 * to the local section with a discreet note — never an error.
 */
export interface QuotaModalProps {
  /** The session's merged endpoint profiles (`session.endpointProfiles`). */
  endpoints: EndpointProfile[];
  /** Local measured usage: per-model rows from the open session's events. */
  localUsage: LocalUsageRow[];
  /** Probe seam (defaults to the core `getQuota`; tests inject fixtures). */
  probe?: (endpoint: EndpointProfile) => Promise<QuotaReport | null>;
  onClose: () => void;
}

type ReportState = Record<string, QuotaReport | null | "loading">;

/** Cache TTL for probe results (issue decision: 60s, on-open only). */
const CACHE_TTL_MS = 60_000;

const moduleCache = new Map<string, { at: number; report: QuotaReport | null }>();

export function clearQuotaCache(): void {
  moduleCache.clear();
}

export function QuotaModal({ endpoints, localUsage, probe, onClose }: QuotaModalProps) {
  const theme = useTheme();
  const [reports, setReports] = useState<ReportState>({});
  const [tick, setTick] = useState(0);
  const [nonce, setNonce] = useState(0);

  const probeFn = probe ?? ((e: EndpointProfile) => getQuota(e));

  useEffect(() => {
    let live = true;
    (async () => {
      for (const e of endpoints) {
        const cached = moduleCache.get(e.name);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
          setReports((r) => ({ ...r, [e.name]: cached.report }));
          continue;
        }
        setReports((r) => ({ ...r, [e.name]: "loading" }));
        const report = await probeFn(e).catch(() => null);
        moduleCache.set(e.name, { at: Date.now(), report });
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

  const probed = endpoints.filter((e) => reports[e.name] !== undefined);
  const anyUnavailable = probed.some((e) => reports[e.name] === null);
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;

  return (
    <Dialog title=" usage quota " color={theme.ok}>
      {probed.length === 0 && loading && <Dim>{`${spinner} probing provider quota…`}</Dim>}
      {probed.map((e) => {
        const state = reports[e.name];
        return (
          <QuotaEndpointRows key={e.name} name={e.name} state={state} spinner={spinner} />
        );
      })}
      {anyUnavailable && <Dim> provider quota unavailable — local measurement only</Dim>}
      <Text> </Text>
      <Text bold> local measured (this session)</Text>
      {localUsage.length === 0 && <Dim> no model calls yet</Dim>}
      {localUsage.map((row) => (
        <LocalRow key={row.model} row={row} />
      ))}
      <Text> </Text>
      <Dim>● documented · ○ provider-reported · r refresh · esc close</Dim>
    </Dialog>
  );
}

function QuotaEndpointRows({ name, state, spinner }: { name: string; state: QuotaReport | null | "loading" | undefined; spinner: string }) {
  const theme = useTheme();
  if (state === undefined || state === "loading") {
    return (
      <Text>
        <Text bold>{` ${name}`}</Text>
        <Dim>{` ${spinner} probing…`}</Dim>
      </Text>
    );
  }
  if (state === null) {
    return (
      <Text>
        <Text bold>{` ${name}`}</Text>
        <Dim> — no quota source</Dim>
      </Text>
    );
  }
  return (
    <>
      <Text bold>{` ${name}`}</Text>
      {state.windows.map((w, i) => (
        <WindowRow key={i} name={name} window={w} source={state.source} />
      ))}
    </>
  );
}

function WindowRow({ name, window: w, source }: { name: string; window: { label: string; percent?: number; used?: number; limit?: number; resetAt?: number }; source: "official" | "undocumented" }) {
  const theme = useTheme();
  const badge = source === "official" ? <Text color={theme.ok}>●</Text> : <Text color={theme.dim}>○</Text>;
  const fraction = w.percent !== undefined ? w.percent / 100 : w.used !== undefined && w.limit ? w.used / w.limit : undefined;
  const detail =
    w.used !== undefined && w.limit !== undefined
      ? `${formatCount(w.used)} / ${formatCount(w.limit)}`
      : w.percent !== undefined
        ? `${Math.round(w.percent)}%`
        : "";
  const reset = w.resetAt !== undefined ? ` · resets ${formatReset(w.resetAt)}` : "";
  return (
    <Text>
      {" "}
      {badge} <Text>{`${w.label}: `}</Text>
      <Text color={fractionColor(fraction, theme)}>{detail}</Text>
      {fraction !== undefined && <QuotaBar fraction={fraction} />}
      <Dim>{reset}</Dim>
    </Text>
  );
}

function LocalRow({ row }: { row: LocalUsageRow }) {
  return (
    <Text>
      <Text color="yellow">—</Text>
      {` ${row.model}: ${formatCount(row.inputTokens)} in · ${formatCount(row.outputTokens)} out (${row.calls} call${row.calls === 1 ? "" : "s"})`}
    </Text>
  );
}

/** The quota bar mirrors the BottomBar context bar (███·██). */
function QuotaBar({ fraction }: { fraction: number }) {
  const theme = useTheme();
  const cells = 12;
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * cells);
  return (
    <Text>
      <Text color={theme.border}> [</Text>
      <Text color={fractionColor(fraction, theme)}>{"█".repeat(filled)}</Text>
      <Text color={theme.border}>{"·".repeat(cells - filled) + "]"}</Text>
    </Text>
  );
}

function fractionColor(fraction: number | undefined, theme: { ok: string; warn: string; err: string }): string | undefined {
  if (fraction === undefined) return undefined;
  return fraction > 0.8 ? theme.err : fraction > 0.6 ? theme.warn : theme.ok;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatReset(at: number): string {
  const diffMs = at - Date.now();
  if (diffMs <= 0) return "now";
  const h = Math.floor(diffMs / 3_600_000);
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24 > 0 ? ` ${h % 24}h` : ""}`;
  if (h >= 1) return `${h}h${Math.floor((diffMs % 3_600_000) / 60_000) > 0 ? ` ${Math.floor((diffMs % 3_600_000) / 60_000)}m` : ""}`;
  return `${Math.max(1, Math.floor(diffMs / 60_000))}m`;
}

// `truncate` is re-exported use for narrow viewports; referenced to keep
// the import honest if rows grow windowed later.
void truncate;
