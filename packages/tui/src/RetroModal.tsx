import React, { useState } from "react";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Text, useInput } from "ink";
import {
  applyRetroApplication,
  proposeRetroApplication,
  type RetroFinding,
  type RetroReport,
} from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim, ScrollDialog, type ScrollRow } from "./ui";
import { dialogWidth, useViewport, wrapLines } from "./viewport";

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
 *
 * #1341: the whole report is one ScrollDialog body — the list rows, the
 * selected finding's detail and its proposal are rows with measured
 * weights (wrapLines at the dialog's inner width, #1042's rule), so the
 * dialog always fits the terminal and scrolls instead of clipping its
 * borders. `↑`/`↓` move the selection; ScrollDialog's own scroller keeps
 * the selected rows in view.
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
  const [createMissing, setCreateMissing] = useState(false);
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
      // #1343 follow-up: a missing steering file is not a dead end. The
      // first `a` arms the normal confirm; when the target does not exist,
      // the prompt says so and `y` consents to creating it too — same
      // explicit gate, wider consent. The file lands in the project root
      // (committable): that is where the model reads steering files.
      const target = proposeRetroApplication(selected).target;
      setCreateMissing(target !== "" && !existsSync(join(cwd, target)));
    }
  });

  const viewport = useViewport();
  // The wrapped width inside the dialog: paddingX=2 per side (4) plus the
  // one leading space; rounding one line shorter than reality only costs
  // one scroll row, an overestimate costs a border.
  const detailWidth = Math.max(20, dialogWidth(viewport) - 14);
  const wrap = (text: string): string[] => wrapLines(text, detailWidth);

  const rows: ScrollRow[] = [];
  const row = (node: React.ReactNode, weight = 1): void => {
    rows.push({ node, weight });
  };

  if (report === null) {
    row(<Dim> retro findings are disabled for this session (moh.json "retro.enabled": false)</Dim>);
  } else if (findings.length === 0) {
    row(
      <Dim>
        {" "}
        no open findings
        {dismissed.length > 0
          ? ` — ${dismissed.length} dismissal${dismissed.length === 1 ? "" : "s"} recorded (last ${dismissed.at(-1)!.dismissedAt.slice(0, 10)})`
          : " — findings collect automatically as sessions close"}
      </Dim>,
    );
  } else {
    findings.forEach((finding, i) => {
      const isSel = i === clamped;
      row(
        <Text bold={isSel} wrap="truncate">
          {" "}
          {isSel ? "▸" : " "} [{finding.category}] {pct(finding.confidence)}
          {isSel ? "" : " "}
          {isSel ? null : <Dim> {finding.evidence.slice(0, 48)}</Dim>}
        </Text>,
      );
      if (isSel) {
        // The selected finding's detail rides the scroll: full evidence,
        // lineage, and the proposed application — everything measured at
        // its wrapped height so the dialog never clips (#1341).
        for (const line of wrap(finding.evidence)) row(<Text> {line}</Text>);
        row(<Dim> session {finding.session} · appended {finding.appendedAt.slice(0, 10)}</Dim>);
        if (finding.lineage) row(<Dim> dismissed in similar form on {finding.lineage.slice(0, 10)}</Dim>);
        const application = proposeRetroApplication(finding);
        row(<Text> </Text>);
        row(<Text bold> proposed application</Text>);
        if (application.target) {
          for (const line of wrap(application.proposal)) row(<Text> {line}</Text>);
          row(<Dim> target {application.target}</Dim>);
        } else {
          row(<Dim> {application.proposal}</Dim>);
        }
      }
    });
  }

  const footer = confirming ? (
    <Text color={theme.warn}>
      {" "}
      apply to {proposeRetroApplication(confirming).target}
      {createMissing ? " (missing — y creates it)" : ""}? <Dim>y confirm · n cancel</Dim>
    </Text>
  ) : (
    <Dim> ↑/↓ select · a apply · d dismiss · esc close</Dim>
  );

  if (report === null || findings.length === 0) {
    // Degenerate shapes fit without a scroller: keep the plain Dialog.
    return (
      <Dialog title=" retro findings " color={theme.accent}>
        {rows[0]?.node}
        {status ? <Text color={theme.warn}> {status}</Text> : null}
      </Dialog>
    );
  }
  // The status joins the footer: ScrollDialog counts the footer in its
  // chrome budget, a header line it does not — an uncounted row made the
  // dialog brush the exact terminal height and lose both borders (#1343
  // follow-up).
  const footerWithStatus = status ? (
    <>
      <Text color={theme.warn}> {status}</Text>
      {footer}
    </>
  ) : (
    footer
  );
  return (
    <ScrollDialog
      title=" retro findings "
      color={theme.accent}
      rows={rows}
      scrollHint={false}
      footer={footerWithStatus}
    />
  );
}
