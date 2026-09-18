import React from "react";
import { Text, useInput } from "ink";
import { PRICING_SNAPSHOT, type SessionAnalysisReport } from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * The session analysis modal (#767): opened with /session from chat. A
 * snapshot computed at open time — no live refresh — over the current
 * session's active branch: usage by model (pricing-snapshot convention),
 * tool health with errorKind breakdown, permission counts, shape and
 * tree stats, wall and tool durations. Same read-only metadata discipline
 * as the core report it renders.
 */
export interface SessionModalProps {
  report: SessionAnalysisReport;
  onClose: () => void;
}

const num = (n: number): string => n.toLocaleString("en-US");
const formatUsd = (usd: number): string => `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
const formatMs = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

export function SessionModal({ report, onClose }: SessionModalProps) {
  const theme = useTheme();
  useInput((_input, key) => {
    if (key.escape || _input === "q") return onClose();
  });

  const priced = report.models.filter((m) => m.estimatedCostUsd !== undefined);
  const unpriced = report.models.length - priced.length;
  const totalUsd = priced.reduce((a, m) => a + m.estimatedCostUsd!, 0);
  const totalTok = report.models.reduce((a, m) => a + m.inputTokens + m.outputTokens, 0);
  const s = report.shape;

  return (
    <Dialog title=" session " color={theme.accent}>
      <Text bold> usage by model</Text>
      {report.models.length === 0 ? (
        <Dim> no model calls on the active path</Dim>
      ) : (
        report.models.map((m) => (
          <Text key={m.model}>
            {" "}
            {m.model} <Dim>·</Dim> {num(m.calls)} call{m.calls === 1 ? "" : "s"} <Dim>·</Dim> {num(m.inputTokens)} in /{" "}
            {num(m.outputTokens)} out
            {m.estimatedCostUsd !== undefined ? (
              <>
                <Dim> ·</Dim> est. {formatUsd(m.estimatedCostUsd)}
              </>
            ) : (
              <Dim> · unpriced</Dim>
            )}
          </Text>
        ))
      )}
      <Text> </Text>
      <Text>
        {" "}
        {num(totalTok)} tokens · wall {formatMs(report.wallTimeMs)} · tools {formatMs(report.toolDurationMs)}
        {priced.length > 0 ? (
          <>
            <Dim> ·</Dim> est. {formatUsd(totalUsd)}
            {unpriced > 0 ? <Dim> (partial; {unpriced} unpriced)</Dim> : null}
          </>
        ) : unpriced > 0 ? (
          <Dim> · no pricing for {unpriced} model{unpriced === 1 ? "" : "s"}</Dim>
        ) : null}
      </Text>
      <Dim> pricing snapshot {PRICING_SNAPSHOT.version}</Dim>

      <Text> </Text>
      <Text bold> tool health (calls / ok / fail)</Text>
      {report.tools.length === 0 ? (
        <Dim> no tool calls on the active path</Dim>
      ) : (
        report.tools.map((t) => {
          const kinds =
            t.errorKinds && Object.keys(t.errorKinds).length > 0
              ? ` — ${Object.entries(t.errorKinds).map(([k, v]) => `${k}: ${v}`).join(", ")}`
              : "";
          return (
            <Text key={t.tool}>
              {" "}
              {t.tool} <Dim>·</Dim> {t.calls} / {t.ok} / {t.fail}
              {kinds ? <Text color={theme.warn}>{kinds}</Text> : null}
            </Text>
          );
        })
      )}

      <Text> </Text>
      <Text bold> shape</Text>
      <Text>
        {" "}
        {s.turns} turn{s.turns === 1 ? "" : "s"} ({s.done} done, {s.error} error, {s.cancelled} cancelled) ·{" "}
        {s.userMessages} user message{s.userMessages === 1 ? "" : "s"}
      </Text>
      <Text>
        {" "}
        {s.compactions} compaction{s.compactions === 1 ? "" : "s"}
        {s.compactionFailures > 0 ? <Text color={theme.warn}> ({s.compactionFailures} failed)</Text> : null} ·{" "}
        {s.modelSwitches} model switch{s.modelSwitches === 1 ? "" : "es"} · {s.fallbacks} fallback
        {s.fallbacks === 1 ? "" : "s"}
      </Text>

      <Text> </Text>
      <Text bold> permissions & tree</Text>
      <Text>
        {" "}
        {report.permissions.requested} requested · {report.permissions.granted} granted · {report.permissions.denied}{" "}
        denied
      </Text>
      <Text>
        {" "}
        {report.tree.branchCount} branch{report.tree.branchCount === 1 ? "" : "es"} · {report.tree.activePathTurns}{" "}
        turn{report.tree.activePathTurns === 1 ? "" : "s"} on the active path · {report.tree.bookmarks} bookmark
        {report.tree.bookmarks === 1 ? "" : "s"}
      </Text>

      <Text> </Text>
      <Dim> esc / q close — snapshot at open, reopen for fresh numbers</Dim>
    </Dialog>
  );
}
