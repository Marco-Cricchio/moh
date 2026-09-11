import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { TreeNode, TreeView } from "@moh/core";
import { useTheme } from "./themes";
import { useViewport } from "./viewport";
import { sanitizeLine, truncate } from "./ui";

/**
 * The `/tree` panel (#581, spec §2–§3): variant D as ratified — the full
 * topology view ([A]) inside the prototype-D frame grammar (title in the
 * top border, `t.muted` walls, one blank row after the header and before
 * the key hints, truncate-don't-push) with a strict visual row cap and
 * internal scrolling (`↑/↓` or `j/k`).
 *
 * Keys: ⏎ switches here (immediate `branch_switched` — the caller owns
 * the append and any in-flight notice), `r` branch from here (switch +
 * close + sticky banner — caller-owned), `b` toggles a bookmark, `B`
 * prompts for a name, `f` cycles the client-side filters, esc closes.
 * The panel itself never writes to the log: every mutation rides a
 * caller callback over the core seams (`session.switchBranch` /
 * `session.bookmarkNode`), and switching never consumes (no
 * `session_resumed` — ADR-0021).
 */

export type TreeFilter = "all" | "active+bookmarked" | "abandoned only";

const FILTERS: readonly TreeFilter[] = ["all", "active+bookmarked", "abandoned only"];

export function cycleTreeFilter(current: TreeFilter): TreeFilter {
  return FILTERS[(FILTERS.indexOf(current) + 1) % FILTERS.length]!;
}

export interface TreePanelProps {
  /** Session label for the title row (display name or derived title). */
  label: string;
  /** The core projection (refetched by the caller after each action). */
  view: TreeView | { error: string };
  /** ⏎ switch here — the caller appends `branch_switched` immediately. */
  onSwitch: (nodeId: string) => void;
  /** `r` — switch + close panel + sticky banner (caller-owned). */
  onBranchFrom: (node: TreeNode) => void;
  /** `b`/`B` — set (name optional) or clear (empty name) a bookmark. */
  onBookmark: (nodeId: string, name?: string) => void;
  onClose: () => void;
  /** One-line notice above the footer (in-flight turn: the switch takes
   * effect next turn — spec §2, #569 d6). */
  notice?: string | null;
  /** The foreign tail id from the last `session_file_growth` (#400): the
   * branch descending from it renders the warning glyph. */
  foreignTip?: string | null;
  /** Max visible node rows (caller computes from the viewport; internal
   * scrolling keeps the selection in the window). */
  rows?: number;
}

interface Row {
  node: TreeNode;
  foreign: boolean;
}

/** The foreign test: true when the node's parent chain reaches the
 * foreign tail (the #400 divergence), so the whole foreign branch — not
 * just its tip — carries the warning glyph. */
function isForeign(node: TreeNode, byId: Map<string, TreeNode>, foreignTip: string | null): boolean {
  if (foreignTip === null) return false;
  let current: TreeNode | undefined = node;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.id === foreignTip) return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

/** The header chips: the three filters, the active one highlighted. */
export function filterChipsRow(active: TreeFilter): string {
  return FILTERS.map((f) => (f === active ? `[${f}]` : f)).join("  ");
}

export function TreePanel({
  label,
  view,
  onSwitch,
  onBranchFrom,
  onBookmark,
  onClose,
  notice,
  foreignTip = null,
  rows,
}: TreePanelProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const contentW = Math.max(24, Math.min(viewport.columns - 6, 110));
  const rowCap = Math.max(3, rows ?? Math.min(16, Math.max(4, viewport.rows - 12)));

  const [filter, setFilter] = useState<TreeFilter>("all");
  const [selected, setSelected] = useState<string>(() => ("headId" in view ? view.headId : ""));
  const [offset, setOffset] = useState(0);
  const [naming, setNaming] = useState<{ nodeId: string; buffer: string } | null>(null);

  const byId = useMemo(
    () => ("nodes" in view ? new Map(view.nodes.map((n) => [n.id, n])) : new Map<string, TreeNode>()),
    [view],
  );

  const filteredRows = useMemo((): Row[] => {
    if (!("nodes" in view)) return [];
    const keep = view.nodes.filter((node) => {
      if (filter === "all") return true;
      if (filter === "abandoned only") return !node.onActivePath;
      // active+bookmarked: the row itself, plus ancestors that keep the
      // shape legible (a bookmarked leaf without its branch line reads
      // as floating).
      if (node.onActivePath || node.bookmark !== undefined) return true;
      let parent = node.parentId ? byId.get(node.parentId) : undefined;
      const seen = new Set<string>();
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        if (parent.onActivePath || parent.bookmark !== undefined) return true;
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
      return false;
    });
    return keep.map((node) => ({ node, foreign: isForeign(node, byId, foreignTip) }));
  }, [view, filter, byId, foreignTip]);

  // Selection clamps into the visible rows (a filter change or a refetch
  // can drop the selected row entirely).
  const selectedIndex = Math.max(0, filteredRows.findIndex((r) => r.node.id === selected));
  const clampedIndex = Math.min(selectedIndex, Math.max(0, filteredRows.length - 1));
  const lastWindowStart = Math.max(0, filteredRows.length - rowCap);
  // The window follows the selection: the offset is a user nudge (set on
  // move); whenever the selection falls outside the window it snaps back
  // so the selected row is always visible.
  const followStart = Math.min(Math.max(0, clampedIndex - rowCap + 1), clampedIndex);
  const nudged = Math.min(Math.max(0, offset), lastWindowStart);
  const selectionVisible = clampedIndex >= nudged && clampedIndex < nudged + rowCap;
  const scrollOffset = selectionVisible ? nudged : followStart;
  const visible = filteredRows.slice(scrollOffset, scrollOffset + rowCap);
  const moreAbove = scrollOffset > 0;
  const moreBelow = scrollOffset + rowCap < filteredRows.length;

  useInput((input, key) => {
    if (naming) {
      if (key.escape) return setNaming(null);
      if (key.return || input === "\n") {
        onBookmark(naming.nodeId, naming.buffer);
        setNaming(null);
        return;
      }
      if (key.backspace || key.delete) {
        return setNaming((n) => (n ? { ...n, buffer: n.buffer.slice(0, -1) } : n));
      }
      if (input && !key.ctrl && !key.meta) {
        return setNaming((n) => (n ? { ...n, buffer: n.buffer + input } : n));
      }
      return;
    }
    if (key.escape) return onClose();
    if (key.upArrow || input === "k") {
      setOffset(Math.max(0, clampedIndex - rowCap));
      const prev = filteredRows[Math.max(0, clampedIndex - 1)];
      if (prev) setSelected(prev.node.id);
      return;
    }
    if (key.downArrow || input === "j") {
      setOffset(Math.min(Math.max(0, filteredRows.length - rowCap), clampedIndex + 1));
      const next = filteredRows[Math.min(filteredRows.length - 1, clampedIndex + 1)];
      if (next) setSelected(next.node.id);
      return;
    }
    const current = filteredRows[clampedIndex]?.node;
    if (!current) return;
    if (key.return) return onSwitch(current.id);
    if (input === "r") return onBranchFrom(current);
    if (input === "b") return onBookmark(current.id);
    if (input === "B") return setNaming({ nodeId: current.id, buffer: current.bookmark?.name ?? "" });
    if (input === "f") {
      setFilter((f) => cycleTreeFilter(f));
      setOffset(0);
    }
  });

  // ── Frame helpers: every row is one fixed-width Text between muted
  // walls (prototype-D discipline: collapsing/filtering can never move,
  // omit, or wrap a wall). ──────────────────────────────────────────────
  const fill = (s: string, width: number) => truncate(sanitizeLine(s), width).padEnd(width, " ");
  const FrameRow = ({ text, color, backgroundColor }: { text: string; color?: string; backgroundColor?: string }) => (
    <Text>
      <Text color={theme.muted}>│</Text>
      <Text color={color ?? theme.fg} backgroundColor={backgroundColor}>{fill(text, contentW)}</Text>
      <Text color={theme.muted}>│</Text>
    </Text>
  );

  if (!("nodes" in view)) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={theme.muted}>╭─ </Text>
          <Text color={theme.accent}>Session tree</Text>
          <Text color={theme.muted}>{"─".repeat(Math.max(2, contentW - 14))}╮</Text>
        </Text>
        <FrameRow text={` ✗ ${view.error}`} color={theme.err} />
        <Text color={theme.muted}>{"╰" + "─".repeat(contentW) + "╯"}</Text>
      </Box>
    );
  }

  const turns = view.nodes.filter((n) => n.kind === "turn").length;
  const branchCount = (() => {
    const groups = new Map<string, number>();
    for (const n of view.nodes) {
      if (n.kind !== "turn") continue;
      const key = n.parentId ?? "root";
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return 1 + [...groups.values()].reduce((sum, size) => sum + Math.max(0, size - 1), 0);
  })();

  const title = `╭─ `;
  const titleText = `Session tree`;
  const subtitle = ` — ${label} · ${branchCount} ${branchCount === 1 ? "branch" : "branches"} · ${turns} ${turns === 1 ? "turn" : "turns"} `;
  const titlePad = Math.max(2, contentW + 3 - (title.length + titleText.length + subtitle.length));
  const topBorder =
    title +
    titleText +
    subtitle +
    "─".repeat(titlePad) +
    "╮";

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.muted}>{topBorder.slice(0, 3)}</Text>
        <Text color={theme.accent} bold>{titleText}</Text>
        <Text color={theme.dim}>{subtitle}</Text>
        <Text color={theme.muted}>{"─".repeat(titlePad)}╮</Text>
      </Text>
      <FrameRow text="" />
      <FrameRow text={`filter  ${filterChipsRow(filter)}`} color={theme.dim} />
      <FrameRow text="" />
      {filteredRows.length === 0 && <FrameRow text=" no rows match this filter" color={theme.dim} />}
      {moreAbove && <FrameRow text="  ▲ more" color={theme.dim} />}
      {visible.map(({ node, foreign }) => {
        const isSelected = node.id === filteredRows[clampedIndex]?.node.id;
        const glyph = foreign ? "⚠" : node.bookmark !== undefined ? "◆" : node.onActivePath ? "●" : "○";
        const headMark = node.id === view.headId;
        const color = foreign ? theme.warn : node.onActivePath ? theme.fg : theme.dim;
        const indent = "  ".repeat(node.depth);
        const selector = isSelected ? "▶ " : "  ";
        const bookmark = node.bookmark?.name !== undefined ? ` ◆ ${node.bookmark.name}` : "";
        const head = headMark ? " ← head" : "";
        const prefix = `${indent}${selector}${glyph} `;
        return (
          <FrameRow
            key={node.id}
            text={`${prefix}${truncate(sanitizeLine(node.label), contentW - prefix.length - bookmark.length - head.length)}${bookmark}${head}`}
            color={isSelected ? theme.bg : color}
            backgroundColor={isSelected ? theme.accent : undefined}
          />
        );
      })}
      {moreBelow && <FrameRow text="  ▼ more" color={theme.dim} />}
      <FrameRow text="" />
      {notice && <FrameRow text={` ⑂ ${notice}`} color={theme.warn} />}
      <FrameRow
        text="↑/↓ move · ⏎ switch here · r branch from here · b bookmark · B name · f filter · esc close"
        color={theme.dim}
      />
      <Text color={theme.muted}>{"╰" + "─".repeat(contentW) + "╯"}</Text>
      {naming && (
        <Text>
          <Text color={theme.accent}>bookmark name: </Text>
          <Text>{naming.buffer}</Text>
          <Text color={theme.dim}>▊</Text>
          <Text color={theme.dim}>  (enter save · empty = clear · esc cancel)</Text>
        </Text>
      )}
    </Box>
  );
}
