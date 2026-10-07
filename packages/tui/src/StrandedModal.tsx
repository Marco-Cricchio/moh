import React, { useEffect, useMemo, useState } from "react";
import { Text, useInput } from "ink";
import {
  acknowledgeStrandedData,
  deleteStrandedData,
  moveStrandedSessions,
  readStrandedDataRecord,
  strandedDataSummary,
  type StrandedDataSummary,
} from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * The stranded-data resolution modal (#1243): opened with enter on the home
 * warning row. Shows what is actually in the old directory (the core's
 * read-only `statSync` summary) and offers the ways out — `m` moves the
 * session logs that exist only there into the live directory, `d` deletes
 * the whole old directory (session logs to the project trash, `y` confirms),
 * `k` keeps it and stops the warning via a durable acknowledgement. Owns no
 * re-reads: the reads happen once on open, and Home refreshes on close.
 */
export interface StrandedModalProps {
  /** The live project directory, resolved by the client at boot (#939):
   * the modal must never run a synchronous identity resolution in render. */
  dir: string;
  /** Home for the user-data directories (tests inject a temp home). */
  home?: string;
  onClose: () => void;
}

export function StrandedModal({ dir, home, onClose }: StrandedModalProps) {
  const theme = useTheme();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<StrandedDataSummary | null>(null);
  const record = useMemo(() => readStrandedDataRecord(dir), [dir]);
  // Read once after mount, off the render path: the summary is one
  // readdirSync + statSync per entry and the first frame must not wait.
  useEffect(() => {
    setSummary(strandedDataSummary(dir));
  }, [dir]);

  useInput((input, key) => {
    if (confirming) {
      if (input === "y" || input === "Y") {
        try {
          deleteStrandedData(dir, dir, home);
          onClose();
        } catch (e) {
          setNotice(e instanceof Error ? e.message : String(e));
          setConfirming(false);
        }
        return;
      }
      if (key.escape || key.return || input === "n" || input === "N") {
        setConfirming(false);
        return;
      }
      return;
    }
    if (key.escape) return onClose();
    if (!record) return;
    if (input === "k") {
      try {
        acknowledgeStrandedData(dir);
        onClose();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (input === "m") {
      try {
        const result = moveStrandedSessions(dir);
        if (!readStrandedDataRecord(dir)) return onClose();
        setNotice(`moved ${result.moved.length} · dropped ${result.dropped.length} identical · kept ${result.skipped.length} conflicting — the old directory still holds data`);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (input === "d") {
      setNotice(null);
      setConfirming(true);
    }
  });

  return (
    <Dialog title="older project data" color={theme.warn}>
      <Text color={theme.warn}>{`older data kept in ${record?.source ?? "(record gone)"}`}</Text>
      <Text>{`this project now uses ${record?.destination ?? dir}`}</Text>
      {summary ? (
        <>
          <Text> </Text>
          <Text>{`only in the old directory: ${summary.onlyHere.length} entr${summary.onlyHere.length === 1 ? "y" : "ies"}`}</Text>
          {summary.onlyHere.slice(0, 4).map((name) => (
            <Dim key={name}>{`  ${name}`}</Dim>
          ))}
          {summary.onlyHere.length > 4 ? <Dim>{`  … +${summary.onlyHere.length - 4} more`}</Dim> : null}
          <Text>{`probably identical: ${summary.sameSize.length} · differing: ${summary.differing.length}`}</Text>
        </>
      ) : null}
      <Text> </Text>
      {notice ? (
        <>
          <Text color={theme.warn} wrap="truncate">{notice}</Text>
          <Text> </Text>
        </>
      ) : null}
      {confirming ? (
        <>
          <Text color={theme.warn}>Delete the whole old directory? </Text>
          <Dim>{"session logs go to the project trash · memory, notes and the rest are removed"}</Dim>
          <Text color={theme.dim}>y confirm · n/esc cancel ▊</Text>
        </>
      ) : (
        <>
          <Dim>{"m move unique session logs · d delete the old directory · k keep and stop warning"}</Dim>
          <Dim>{"esc close"}</Dim>
        </>
      )}
    </Dialog>
  );
}
