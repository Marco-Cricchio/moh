import React, { useState } from "react";
import { Text, useInput } from "ink";
import {
  applyRetroApplication,
  proposeRetroApplication,
  type RetroFinding,
  type RetroReport,
} from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * The retro report surface (ADR-0075, #1275): opened with `/retro`. The
 * pull-based door — the digest only ever points here. Findings are listed
 * by confidence with their category, evidence and dismissal lineage; the
 * selected one shows the concrete application the report proposes.
 *
 * Both actions are explicit and stay in this session: `d` records a
 * durable dismissal, `a` asks for confirmation before writing anything.
 * Opening the report suppresses this session's digest (the report
 * replaces it).
 */
export interface RetroModalProps {
  /** Project root — where a confirmed application is written. */
  cwd: string;
  /** The session's own report seam (`AgentSession.retroReport`). Null when
   * retro is disabled for this session — the modal then says so instead of
   * inventing a store the session did not configure. */
  readReport: () => RetroReport | null;
  /** The session's own dismissal seam (`AgentSession.retroDismiss`). */
  dismiss: (signature: string, category: string) => void;
  onClose: () => void;
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;

export function RetroModal({ cwd, readReport, dismiss, onClose }: RetroModalProps) {
  const theme = useTheme();
  const [report, setReport] = useState<RetroReport | null>(() => readReport());
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState<RetroFinding | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const findings = report?.findings ?? [];
  const dismissed = report?.dismissed ?? [];
  const clamped = Math.min(index, Math.max(0, findings.length - 1));
  const selected = findings[clamped];

  const refresh = (nextIndex = clamped) => {
    setReport(readReport());
    setIndex(nextIndex);
  };

  useInput((input, key) => {
    if (confirming) {
      if (input === "y" || key.return) {
        const result = applyRetroApplication({ finding: confirming, projectRoot: cwd, confirm: true });
        setStatus(result.ok ? (result.appended ? `applied to ${result.file}` : "already applied — nothing to do") : result.error);
        setConfirming(null);
        return;
      }
      if (input === "n" || key.escape) {
        setStatus("apply cancelled — nothing was written");
        setConfirming(null);
        return;
      }
      return;
    }
    if (key.escape || input === "q") return onClose();
    if (!selected) return;
    if (key.upArrow || input === "k") return setIndex(Math.max(0, clamped - 1));
    if (key.downArrow || input === "j") return setIndex(Math.min(findings.length - 1, clamped + 1));
    if (input === "d") {
      dismiss(selected.signature, selected.category);
      setStatus(`dismissed: ${selected.category} — this observation will not be proposed again`);
      refresh(Math.max(0, clamped - 1));
      return;
    }
    if (input === "a") {
      setStatus(null);
      setConfirming(selected);
    }
  });

  const application = selected ? proposeRetroApplication(selected) : null;

  return (
    <Dialog title=" retro findings " color={theme.accent}>
      {report === null ? (
        <Dim> retro findings are disabled for this session (moh.json "retro.enabled": false)</Dim>
      ) : findings.length === 0 ? (
        <Dim>
          {" "}
          no open findings
          {dismissed.length > 0
            ? ` — ${dismissed.length} dismissal${dismissed.length === 1 ? "" : "s"} recorded (last ${dismissed.at(-1)!.dismissedAt.slice(0, 10)})`
            : " — findings collect automatically as sessions close"}
        </Dim>
      ) : (
        findings.map((finding, i) => (
          <Text key={finding.signature} bold={i === clamped}>
            {" "}
            {i === clamped ? "▸" : " "} [{finding.category}] {pct(finding.confidence)}
            {i === clamped ? "" : " "}
            {i === clamped ? <Text> {finding.evidence}</Text> : <Dim> {finding.evidence.slice(0, 48)}</Dim>}
          </Text>
        ))
      )}

      {selected ? (
        <>
          <Text> </Text>
          <Text bold> selected</Text>
          <Text> {selected.evidence}</Text>
          <Dim>
            {" "}
            session {selected.session} · appended {selected.appendedAt.slice(0, 10)}
          </Dim>
          {selected.lineage ? (
            <Dim> dismissed in similar form on {selected.lineage.slice(0, 10)}</Dim>
          ) : null}
          {application ? (
            <>
              <Text> </Text>
              <Text bold> proposed application</Text>
              {application.target ? (
                <Text> {application.proposal}</Text>
              ) : (
                <Dim> {application.proposal}</Dim>
              )}
              <Dim> target {application.target || "(none — review by hand)"}</Dim>
            </>
          ) : null}
        </>
      ) : null}

      {status ? (
        <>
          <Text> </Text>
          <Text color={theme.warn}> {status}</Text>
        </>
      ) : null}

      <Text> </Text>
      {confirming ? (
        <Text color={theme.warn}>
          {" "}
          apply to {proposeRetroApplication(confirming).target}? <Dim>y confirm · n cancel</Dim>
        </Text>
      ) : (
        <Dim> ↑/↓ select · a apply · d dismiss · esc close</Dim>
      )}
    </Dialog>
  );
}
