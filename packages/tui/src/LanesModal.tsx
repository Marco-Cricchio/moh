import React, { useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DevelopmentLaneStore, type DevelopmentLane, type FeatureGroup } from "@moh/core";
import { homedir } from "node:os";
import { useTheme } from "./themes";
import { Dialog, Dim, truncate } from "./ui";
import { useViewport } from "./viewport";

/**
 * The lanes modal (ADR-0060): opened with /lanes from chat. Renders the
 * same read-only, metadata-only concepts as `moh lanes list` (CLI) —
 * feature groups, each lane's branch, status, base freshness and worktree
 * health — computed once at open time from the user-owned lane registry.
 * Never source content; the modal cannot mutate lane state (writes belong
 * to the core service through the CLI door).
 *
 * Height-aware (#64): a registry with many groups and lanes scrolls
 * inside a windowed list instead of growing the dialog past the viewport.
 * Every row is exactly one visual line (long lines truncate, never wrap),
 * a lane weighs two lines, and the window follows the cursor (↑↓/j/k).
 */

const STATUS_COLOR: Record<string, "ok" | "warn" | "dim"> = {
  active: "dim",
  ready: "ok",
  conflicted: "warn",
};

function themeColor(theme: ReturnType<typeof useTheme>, status: string) {
  const slot = STATUS_COLOR[status] ?? "dim";
  return slot === "ok" ? theme.ok : slot === "warn" ? theme.warn : theme.dim;
}

type Row =
  | { kind: "spacer"; weight: 1 }
  | { kind: "group"; weight: 1; group: FeatureGroup; laneCount: number }
  | { kind: "lane"; weight: 2; lane: DevelopmentLane };

export interface LanesModalProps {
  /** Project root whose lane registry is inspected. */
  cwd: string;
  /** Home for the user-data registry (tests inject a temp home). */
  home?: string;
  onClose: () => void;
}

/** Cursor-following window over weighted rows: grows around the cursor
 * within `budget` visual lines, keeping the cursor's row fully visible. */
function windowFor(weights: number[], cursor: number, budget: number): { start: number; count: number } {
  if (weights.length === 0) return { start: 0, count: 0 };
  const c = Math.min(cursor, weights.length - 1);
  let start = c;
  let end = c + 1;
  let used = weights[c]!;
  for (;;) {
    let grew = false;
    if (end < weights.length && used + weights[end]! <= budget) {
      used += weights[end]!;
      end++;
      grew = true;
    }
    if (start > 0 && used + weights[start - 1]! <= budget) {
      start--;
      used += weights[start]!;
      grew = true;
    }
    if (!grew) break;
  }
  return { start, count: end - start };
}

export function LanesModal({ cwd, home, onClose }: LanesModalProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const [cursor, setCursor] = useState(0);
  // One snapshot at open (the /session modal convention): the modal is a
  // projection, not a live writer.
  let groups: FeatureGroup[] = [];
  let lanes: DevelopmentLane[] = [];
  let error: string | null = null;
  try {
    const store = new DevelopmentLaneStore({ cwd, home: home ?? homedir() });
    groups = store.listFeatureGroups();
    lanes = store.listLanes();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    groups.forEach((group, index) => {
      if (index > 0) out.push({ kind: "spacer", weight: 1 });
      const groupLanes = lanes.filter((lane) => lane.featureGroupId === group.id);
      out.push({ kind: "group", weight: 1, group, laneCount: groupLanes.length });
      for (const lane of groupLanes) out.push({ kind: "lane", weight: 2, lane });
    });
    return out;
  }, [groups, lanes]);

  useInput((input, key) => {
    if (key.escape || input === "q") return onClose();
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(rows.length - 1, c + 1));
  });

  const shortId = (id: string) => id.replace(/^lane-|^feature-/, "").slice(0, 8);
  const worktreeStatus = (lane: DevelopmentLane) => {
    try {
      return existsSync(join(lane.worktreePath, ".git")) ? null : "worktree MISSING";
    } catch {
      return "worktree unreadable";
    }
  };

  // Height-aware list (#64): the rows scroll inside the dialog. The budget
  // subtracts the fixed chrome (title, blank, blank, footer, indicators).
  const budget = Math.max(3, viewport.rows - 8);
  const win = windowFor(
    rows.map((row) => row.weight),
    cursor,
    budget,
  );
  // Two lines per lane max: primary line and a dim detail line, both
  // hard-truncated to the dialog's inner width — never wrapped.
  const width = Math.min(viewport.columns - 2, 90);
  const lineBudget = Math.max(20, width - 6);

  const current = rows[Math.min(cursor, rows.length - 1)];
  const currentLane = current?.kind === "lane" ? current.lane : null;
  const removeHint = currentLane ? ` · remove row: moh lanes remove ${currentLane.id}` : "";

  const ageDays = (lane: DevelopmentLane) =>
    Math.max(0, Math.floor((Date.now() - Date.parse(lane.updatedAt)) / 86_400_000));

  return (
    <Dialog title=" lanes " color={theme.accent} width={width}>
      {error && <Text color={theme.err}>registry unreadable: {error}</Text>}
      {!error && groups.length === 0 && (
        <Dim>no feature groups yet — start one with: moh lanes group {"<name>"}</Dim>
      )}
      {win.start > 0 && <Dim>{` ↑ ${win.start} more`}</Dim>}
      {!error &&
        rows.slice(win.start, win.start + win.count).map((row, i) => {
          const index = win.start + i;
          if (row.kind === "spacer") return <Text key={`spacer-${index}`}> </Text>;
          if (row.kind === "group") {
            return (
              <Text key={row.group.id} wrap="truncate-end">
                <Text bold>{truncate(row.group.name, lineBudget - 24)}</Text>
                <Dim>
                  {` (${shortId(row.group.id)}) → ${row.group.targetRef}`}
                  {row.laneCount === 0 ? " · no lanes" : ""}
                </Dim>
              </Text>
            );
          }
          const lane = row.lane;
          const color = themeColor(theme, lane.status);
          const missing = worktreeStatus(lane);
          const head = truncate(
            `● ${lane.status} ${lane.label ? `"${lane.label}"` : lane.branchRef}${lane.parentLaneId ? ` ← ${shortId(lane.parentLaneId)}` : ""} · ${ageDays(lane)}d`,
            lineBudget,
          );
          const detail = truncate(
            `  ${lane.label ? lane.branchRef : lane.relation}${missing ? ` · ${missing}` : ""} · base ${lane.baseRef} @ ${lane.baseRevision.slice(0, 8)}`,
            lineBudget,
          );
          return (
            <React.Fragment key={lane.id}>
              <Text inverse={index === cursor} wrap="truncate-end">
                <Text color={index === cursor ? theme.accent : color}>{head.slice(0, 2)}</Text>
                {head.slice(2)}
              </Text>
              <Text wrap="truncate-end">
                <Dim>{detail}</Dim>
              </Text>
            </React.Fragment>
          );
        })}
      {win.start + win.count < rows.length && (
        <Dim>{` ↓ ${rows.length - win.start - win.count} more`}</Dim>
      )}
      <Text> </Text>
      <Dim>↑↓ move · esc close · writes: moh lanes integrate/resolve/abandon {"<lane-id>"}{removeHint}</Dim>
    </Dialog>
  );
}
