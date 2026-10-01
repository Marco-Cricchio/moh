import React from "react";
import { Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DevelopmentLaneStore, type DevelopmentLane, type FeatureGroup } from "@moh/core";
import { homedir } from "node:os";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * The lanes modal (ADR-0060): opened with /lanes from chat. Renders the
 * same read-only, metadata-only concepts as `moh lanes list` (CLI) —
 * feature groups, each lane's branch, status, base freshness and worktree
 * health — computed once at open time from the user-owned lane registry.
 * Never source content; the modal cannot mutate lane state (writes belong
 * to the core service through the CLI door).
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

export interface LanesModalProps {
  /** Project root whose lane registry is inspected. */
  cwd: string;
  /** Home for the user-data registry (tests inject a temp home). */
  home?: string;
  onClose: () => void;
}

export function LanesModal({ cwd, home, onClose }: LanesModalProps) {
  const theme = useTheme();
  useInput((_input, key) => {
    if (key.escape) return onClose();
  });
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

  const shortId = (id: string) => id.replace(/^lane-|^feature-/, "").slice(0, 8);
  const worktreeStatus = (lane: DevelopmentLane) => {
    try {
      return existsSync(join(lane.worktreePath, ".git")) ? null : "worktree MISSING";
    } catch {
      return "worktree unreadable";
    }
  };

  return (
    <Dialog title=" lanes " color={theme.accent}>
      {error && <Text color={theme.err}>registry unreadable: {error}</Text>}
      {!error && groups.length === 0 && (
        <Dim>no feature groups yet — start one with: moh lanes group {"<name>"}</Dim>
      )}
      {!error &&
        groups.map((group, index) => {
          const groupLanes = lanes.filter((lane) => lane.featureGroupId === group.id);
          return (
            <React.Fragment key={group.id}>
              {index > 0 && <Text> </Text>}
              <Text bold>
                {group.name} <Dim>({shortId(group.id)}) → {group.targetRef}</Dim>
              </Text>
              {groupLanes.length === 0 && <Dim> no lanes</Dim>}
              {groupLanes.map((lane) => {
                const color = themeColor(theme, lane.status);
                const missing = worktreeStatus(lane);
                const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(lane.updatedAt)) / 86_400_000));
                return (
                  <Text key={lane.id}>
                    <Text color={color}>●</Text> {lane.status}{" "}
                    {lane.label ? <Text bold>"{lane.label}"</Text> : <Text bold>{lane.branchRef}</Text>}
                    {lane.parentLaneId && <Dim> ← {shortId(lane.parentLaneId)}</Dim>}
                    <Dim> · {ageDays}d</Dim>
                    {"  "}
                    <Dim>
                      {lane.label ? lane.branchRef : lane.relation} · base {lane.baseRef} @ {lane.baseRevision.slice(0, 8)}
                      {missing ? ` · ${missing}` : ""}
                    </Dim>
                  </Text>
                );
              })}
            </React.Fragment>
          );
        })}
      <Text> </Text>
      <Dim>esc close · writes: moh lanes integrate/resolve/abandon {"<lane-id>"} · cleanup: moh lanes cleanup --apply</Dim>
    </Dialog>
  );
}
