import React, { useCallback, useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DevelopmentLaneService, DevelopmentLaneStore, laneInstallLine, type DevelopmentLane, type FeatureGroup } from "@moh/core";
import { homedir } from "node:os";
import { useTheme } from "./themes";
import { Dialog, Dim, truncate } from "./ui";
import { useViewport } from "./viewport";

/**
 * The lanes modal (ADR-0060): opened with /lanes from chat. Renders the
 * same metadata-only concepts as `moh lanes list` (CLI) — feature groups,
 * each lane's branch, status, base freshness and worktree health.
 *
 * Writes (amendment 3): the modal owns two destructive doors through the
 * core service — `d` deletes the focused lane outright (worktree +
 * branch + registry row, `y` confirms), `x` drops only its registry row,
 * and `D` deletes every lane of every group after an explicit typed
 * confirmation (`delete all`). Everything else stays read-only; the CLI
 * door (`moh lanes …`) remains the surface for the non-destructive
 * lifecycle (integrate/resolve/abandon/status).
 *
 * Height-aware (#64): a registry with many groups and lanes scrolls
 * inside a windowed list instead of growing the dialog past the viewport.
 * Every row is exactly one visual line (long lines truncate, never wrap),
 * a lane weighs two lines, and the window follows the cursor (↑↓/j/k).
 *
 * Amendment 5: each lane's dependency-install state is part of its detail
 * line, and a drifted CHECKOUT install is reported read-only in one line
 * (the repair is the CLI door: `moh lanes repair --apply`).
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
  const [snapshot, setSnapshot] = useState(0); // bumped after each write: re-read the registry
  const [pendingDelete, setPendingDelete] = useState<DevelopmentLane | null>(null);
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const service = useMemo(
    () => new DevelopmentLaneService({ cwd, home: home ?? homedir() }),
    [cwd, home],
  );

  // Re-read per snapshot: the modal is a projection that re-projects after
  // its own writes (one snapshot at open, like /session, plus one per
  // mutation — never a live watcher).
  let groups: FeatureGroup[] = [];
  let lanes: DevelopmentLane[] = [];
  let error: string | null = null;
  let drifted = false;
  try {
    groups = service.store.listFeatureGroups();
    lanes = service.store.listLanes();
    drifted = service.checkoutInstallDrift().drifted;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  void snapshot;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    groups.forEach((group, index) => {
      if (index > 0) out.push({ kind: "spacer", weight: 1 });
      const groupLanes = lanes.filter((lane) => lane.featureGroupId === group.id);
      out.push({ kind: "group", weight: 1, group, laneCount: groupLanes.length });
      for (const lane of groupLanes) out.push({ kind: "lane", weight: 2, lane });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, error]);

  const reload = useCallback(() => {
    setSnapshot((s) => s + 1);
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 3)));
  }, [rows.length]);

  const shortId = (id: string) => id.replace(/^lane-|^feature-/, "").slice(0, 8);
  const worktreeStatus = (lane: DevelopmentLane) => {
    try {
      return existsSync(join(lane.worktreePath, ".git")) ? null : "worktree MISSING";
    } catch {
      return "worktree unreadable";
    }
  };

  // Height-aware list (#64): the rows scroll inside the dialog. The budget
  // subtracts the fixed chrome (title, blank, blank, footer, indicators)
  // plus the drift line when it is shown.
  const budget = Math.max(3, viewport.rows - (drifted ? 9 : 8));
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

  const report = (r: { ok: true; value: DevelopmentLane } | { ok: false; error: { kind: string; message: string } }, verb: string) => {
    setToast(r.ok ? `${verb}: ${r.value.id}` : `${verb} failed (${r.error.kind}): ${r.error.message}`);
    if (r.ok) reload();
  };

  useInput((input, key) => {
    if (pendingDeleteAll) {
      if (key.escape) {
        setPendingDeleteAll(false);
        setConfirmText("");
        return;
      }
      if (key.backspace || key.delete) {
        setConfirmText((t) => t.slice(0, -1));
        return;
      }
      if (key.return) {
        if (confirmText.trim() !== "delete all") {
          setToast("confirmation must be exactly: delete all");
          setConfirmText("");
          return;
        }
        setPendingDeleteAll(false);
        setConfirmText("");
        void (async () => {
          let last: { ok: boolean; text: string } | null = null;
          const ids = service.store.listLanes().map((lane) => lane.id);
          for (const id of ids) {
            const r = await service.deleteLane(id);
            last = r.ok ? { ok: true, text: `deleted: ${r.value.id}` } : { ok: false, text: `delete failed (${r.error.kind}): ${r.error.message}` };
            if (!r.ok) break; // stop at the first refusal — never sweep past an error
          }
          setToast(last ? last.text : "no lanes to delete");
          reload();
        })();
        return;
      }
      if (input && !key.upArrow && !key.downArrow && !key.tab && input.length === 1) {
        setConfirmText((t) => t + input);
      }
      return;
    }
    if (pendingDelete) {
      if (key.escape || input === "n") {
        setPendingDelete(null);
        return;
      }
      if (input === "y") {
        const lane = pendingDelete;
        setPendingDelete(null);
        void service.deleteLane(lane.id).then((r) => report(r, "deleted"));
      }
      return;
    }
    if (key.escape || input === "q") return onClose();
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(rows.length - 1, c + 1));
    if (input === "d" && currentLane) return setPendingDelete(currentLane);
    if (input === "x" && currentLane) {
      void service.remove(currentLane.id, { force: true }).then((r) => report(r, "removed row"));
      return;
    }
    if (input === "D" && lanes.length > 0) {
      setPendingDeleteAll(true);
      setConfirmText("");
    }
  });

  const ageDays = (lane: DevelopmentLane) =>
    Math.max(0, Math.floor((Date.now() - Date.parse(lane.updatedAt)) / 86_400_000));

  const footer = pendingDeleteAll
    ? `type "delete all" + enter to wipe every lane and worktree · esc cancel`
    : pendingDelete
      ? `delete ${pendingDelete.label ? `"${pendingDelete.label}"` : pendingDelete.branchRef} — worktree + branch + row? y/N`
      : `↑↓ move · d delete lane · x drop row · D delete ALL · esc close`;

  return (
    <Dialog title=" lanes " color={theme.accent} width={width}>
      {error && <Text color={theme.err}>registry unreadable: {error}</Text>}
      {!error && groups.length === 0 && (
        <Dim>no feature groups yet — start one with: moh lanes group {"<name>"}</Dim>
      )}
      {!error && drifted && (
        <Text color={theme.warn}>
          {truncate("checkout install drifted — moh lanes repair --apply", lineBudget)}
        </Text>
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
          const install = laneInstallLine(lane.install);
          const head = truncate(
            `● ${lane.status} ${lane.label ? `"${lane.label}"` : lane.branchRef}${lane.parentLaneId ? ` ← ${shortId(lane.parentLaneId)}` : ""} · ${ageDays(lane)}d`,
            lineBudget,
          );
          const detail = truncate(
            `  ${lane.label ? lane.branchRef : lane.relation}${missing ? ` · ${missing}` : ""} · base ${lane.baseRef} @ ${lane.baseRevision.slice(0, 8)}${install ? ` · ${install}` : ""}`,
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
      {toast && <Text color={theme.warn} wrap="truncate-end">{truncate(toast, lineBudget)}</Text>}
      {pendingDeleteAll && <Text>confirm: {confirmText}</Text>}
      <Dim>{truncate(footer, lineBudget)}</Dim>
    </Dialog>
  );
}
