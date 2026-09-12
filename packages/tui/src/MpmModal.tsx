import React from "react";
import { Text, useInput } from "ink";
import { type MpmDiagnostics } from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * The MPM inspection modal (#619): opened with /mpm from chat. Renders the
 * same read-only, metadata-only diagnostic concepts as `moh mpm` (CLI,
 * #618) — status, coverage, freshness, pending work, budgets, exclusions,
 * evictions, fallback reason — enriched with the session's live lifecycle
 * state. Never source content, never prompt text; background MPM work
 * never writes anything to the transcript.
 */
export interface MpmModalProps {
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
};

export function MpmModal({ diagnostics: d, onClose }: MpmModalProps) {
  const theme = useTheme();
  useInput((_input, key) => {
    if (key.escape) return onClose();
  });
  const color = d.status === "ready" ? theme.ok : d.status === "updating" ? theme.accent : theme.dim;
  const statusGlyph = d.status === "ready" ? "✓" : d.status === "updating" ? "↻" : "—";
  return (
    <Dialog title=" project map " color={color}>
      <Text>
        <Text color={color} bold>{statusGlyph} {d.status}</Text>
        {d.disabled && <Dim>{` — disabled (${d.disabledReason ?? "config"})`}</Dim>}
      </Text>
      {!d.disabled && (
        <>
          <Text> </Text>
          <Text bold> projection</Text>
          <Text> {d.fileCount} file(s) · {d.symbolCount} symbol(s) · built {fmtAge(d.builtAt)}</Text>
          {d.staleCount > 0 && <Text color={theme.warn}> {d.staleCount} sampled path(s) changed since mapping</Text>}
          {d.pendingWork > 0 && <Dim>{` ${d.pendingWork} path(s) awaiting background refresh`}</Dim>}
          <Text> </Text>
          <Text bold> coverage</Text>
          {d.coverage.length === 0 && <Dim> nothing mapped yet</Dim>}
          {d.coverage.slice(0, 8).map((c) => (
            <Text key={c.language}> {c.language}: {c.files} file(s) · {c.symbols} symbol(s)</Text>
          ))}
          <Text> </Text>
          <Text bold> budget</Text>
          <Text> {d.fileCount}/{d.budget.maxFiles} files · {Math.round(d.budget.maxTotalBytes / (1024 * 1024))}MB cap</Text>
          {d.evictions > 0 && <Dim>{` ${d.evictions} path(s) evicted by quota this session`}</Dim>}
          {d.exclusions.length > 0 && (
            <>
              <Text> </Text>
              <Text bold> exclusions</Text>
              {d.exclusions.slice(0, 6).map((pattern) => (
                <Dim key={pattern}>{` ${pattern}`}</Dim>
              ))}
              {d.exclusions.length > 6 && <Dim>{` …and ${d.exclusions.length - 6} more`}</Dim>}
            </>
          )}
          {d.fallbackReason && (
            <>
              <Text> </Text>
              <Dim>{` last orientation fallback: ${FALLBACK_LABEL[d.fallbackReason] ?? d.fallbackReason}`}</Dim>
            </>
          )}
        </>
      )}
      <Text> </Text>
      <Dim>metadata only — never source content · esc close</Dim>
    </Dialog>
  );
}
