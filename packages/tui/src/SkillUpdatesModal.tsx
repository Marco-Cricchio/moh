import React, { useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { diffSkillFiles, type UpstreamUpdate } from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";
import { useViewport, windowing } from "./viewport";

export interface SkillUpdatesModalProps {
  updates: UpstreamUpdate[];
  /** Kept at the client boundary: the core still owns file writes and hash checks. */
  readInstalled: (name: string) => Record<string, string>;
  /** Explicit consent to apply the complete displayed plan. */
  onApply: () => void;
  /** Leaves the plan and every installed file untouched. */
  onClose: () => void;
}

/** TUI projection of a checked upstream skill-update plan (#372).
 * It owns neither discovery nor writes: the App feeds the checked plan and
 * routes explicit consent back through `applyUpstreamUpdates`. */
export function SkillUpdatesModal({ updates, readInstalled, onApply, onClose }: SkillUpdatesModalProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const [selected, setSelected] = useState(0);
  const [diffOffset, setDiffOffset] = useState(0);
  const [columnOffset, setColumnOffset] = useState(0);
  const update = updates[selected]!;
  const diffLines = useMemo(
    () => diffSkillFiles(readInstalled(update.name), update.files).split("\n"),
    [readInstalled, update],
  );
  const availableRows = Math.max(3, viewport.rows - 13);
  const diffWidth = Math.max(10, viewport.columns - 8);
  const maxColumnOffset = Math.max(0, Math.max(...diffLines.map((line) => line.length)) - diffWidth);
  const win = windowing(diffLines.length, diffOffset, availableRows);

  useInput((input, key) => {
    if (key.escape || input === "c") return onClose();
    if (input === "a" || key.return) return onApply();
    if (key.upArrow) {
      setSelected((value) => Math.max(0, value - 1));
      setColumnOffset(0);
      return setDiffOffset(0);
    }
    if (key.downArrow) {
      setSelected((value) => Math.min(updates.length - 1, value + 1));
      setColumnOffset(0);
      return setDiffOffset(0);
    }
    if (key.leftArrow) return setColumnOffset((value) => Math.max(0, value - 8));
    if (key.rightArrow) return setColumnOffset((value) => Math.min(maxColumnOffset, value + 8));
    if (key.pageUp) return setDiffOffset((value) => Math.max(0, value - availableRows));
    if (key.pageDown) return setDiffOffset((value) => Math.min(Math.max(0, diffLines.length - availableRows), value + availableRows));
  });

  return (
    <Dialog title=" skill updates " color={theme.ok}>
      <Text bold>{`${updates.length} skill update${updates.length === 1 ? "" : "s"} available`}</Text>
      <Dim>select a skill to inspect its complete diff</Dim>
      {updates.map((item, index) => (
        <Text key={item.name} inverse={index === selected}>{` ${index === selected ? "›" : " "} ${item.name} `}</Text>
      ))}
      <Text> </Text>
      <Text bold>{`${update.name} · upstream changes`}</Text>
      {win.above > 0 && <Dim>{`↑ ${win.above} diff lines`}</Dim>}
      {diffLines.slice(win.start, win.start + win.count).map((line, index) => (
        <Text key={`${win.start + index}:${line}`} wrap="truncate-end">{line.slice(columnOffset, columnOffset + diffWidth) || " "}</Text>
      ))}
      {win.below > 0 && <Dim>{`↓ ${win.below} more diff lines (PageDown)`}</Dim>}
      <Text> </Text>
      <Dim>Apply updates changes only moh-owned, unmodified first-party skills. Locally modified copies are skipped.</Dim>
      <Text color={theme.ok}>[a / enter] Apply updates</Text>
      <Text>[c / esc] Cancel / Not now</Text>
      <Dim>↑↓ select skill · ←→ horizontal scroll · PageUp/PageDown vertical scroll</Dim>
    </Dialog>
  );
}
