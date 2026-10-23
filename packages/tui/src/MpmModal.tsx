import React from "react";
import { Text, useInput } from "ink";
import { type MpmDiagnostics } from "@moh/core";
import { useTheme } from "./themes";
import { Dim, ScrollDialog, type ScrollRow } from "./ui";

/**
 * The MPM inspection modal (#619): opened with /mpm from chat. Renders the
 * same read-only, metadata-only diagnostic concepts as `moh mpm` (CLI,
 * #618) — status, coverage, freshness, pending work, budgets, exclusions,
 * evictions, fallback reason — enriched with the session's live lifecycle
 * state. Never source content, never prompt text; background MPM work
 * never writes anything to the transcript. The body scrolls inside the
 * viewport, so a busy projection never overflows a short terminal.
 */
interface MpmModalProps {
  /** The live diagnostics snapshot (fetched fresh on each open). */
  diagnostics: MpmDiagnostics;
  onClose: () => void;
}

function fmtAge(builtAt: number | null): string {
  if (builtAt === null) return "never built";
  const s = Math.max(0, Math.round((Date.now() - builtAt) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)}min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const FALLBACK_LABEL: Record<string, string> = {
  disabled: "mpm disabled",
  unavailable: "projection unavailable",
  stale: "mapped paths stale",
  "no-eligible-seed": "no mapped path in the task",
  "model-seeded": "oriented via mpm_query",
};

const row = (node: React.ReactNode): ScrollRow => ({ node, weight: 1 });
const blank = row(<Text> </Text>);
const head = (label: string): ScrollRow => row(<Text bold>{` ${label}`}</Text>);

export function MpmModal({ diagnostics: d, onClose }: MpmModalProps) {
  const theme = useTheme();
  useInput((_input, key) => {
    if (key.escape) return onClose();
  });
  const color = d.status === "ready" ? theme.ok : d.status === "updating" ? theme.accent : theme.dim;
  const statusGlyph = d.status === "ready" ? "✓" : d.status === "updating" ? "↻" : "—";

  const rows: ScrollRow[] = [
    row(
      <Text>
        <Text color={color} bold>{statusGlyph} {d.status}</Text>
        {d.disabled && <Dim>{` — disabled (${d.disabledReason ?? "config"})`}</Dim>}
      </Text>,
    ),
  ];
  if (!d.disabled) {
    rows.push(
      blank,
      head("projection"),
      row(<Text> {d.fileCount} file(s) · {d.symbolCount} symbol(s) · built {fmtAge(d.builtAt)}</Text>),
    );
    if (d.staleCount > 0) rows.push(row(<Text color={theme.warn}> {d.staleCount} sampled path(s) changed since mapping</Text>));
    if (d.pendingWork > 0) rows.push(row(<Dim>{` ${d.pendingWork} path(s) awaiting background refresh`}</Dim>));
    rows.push(
      blank,
      head("coverage"),
    );
    if (d.coverage.length === 0) rows.push(row(<Dim> nothing mapped yet</Dim>));
    for (const c of d.coverage) {
      rows.push(row(<Text> {c.language}: {c.files} file(s) · {c.symbols} symbol(s)</Text>));
    }
    rows.push(
      blank,
      head("budget"),
      row(<Text> {d.fileCount}/{d.budget.maxFiles} files · {Math.round(d.budget.maxTotalBytes / (1024 * 1024))}MB cap</Text>),
    );
    if (d.evictions > 0) rows.push(row(<Dim>{` ${d.evictions} path(s) evicted by quota this session`}</Dim>));
    if (d.exclusions.length > 0) {
      rows.push(blank, head("exclusions"));
      for (const pattern of d.exclusions) rows.push(row(<Dim>{` ${pattern}`}</Dim>));
    }
    if (d.fallbackReason) {
      rows.push(blank, row(<Dim>{` last orientation fallback: ${FALLBACK_LABEL[d.fallbackReason] ?? d.fallbackReason}`}</Dim>));
    }
  }

  return (
    <ScrollDialog
      title=" project map "
      color={color}
      rows={rows}
      footer={<Dim>metadata only · ↑↓ scroll · esc close</Dim>}
    />
  );
}
