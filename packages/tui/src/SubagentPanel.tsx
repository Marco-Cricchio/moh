import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./themes";
import {
  panelHeader,
  panelFreezeLine,
  PANEL_TAIL_LINES,
  type SubagentTail,
  type TrackedSubagent,
} from "./subagent-panel";

/**
 * The live subagent panel (#497): read-only header + throttled tail of the
 * selected child's event stream. Pure chrome — it renders whatever state
 * the caller passes and never touches the transcript projection (#194,
 * #183). On settle it freezes with a final line and remains until closed.
 */
export function SubagentPanel({
  sub,
  tail,
  now,
  width,
  rows,
}: {
  sub: TrackedSubagent;
  tail: SubagentTail | undefined;
  /** Monotonic now (ms) from the caller's 1Hz tick — keeps elapsed honest. */
  now: number;
  width: number;
  /** Max tail rows the panel may show (caller computes from the viewport). */
  rows?: number;
}) {
  const theme = useTheme();
  // A useful live peek needs enough context to make the child’s progress
  // legible. It keeps up to five truncate-only tail rows; on settlement the
  // caller still reduces it to the one-line final acknowledgement.
  const maxLines = Math.max(1, Math.min(5, PANEL_TAIL_LINES, rows ?? PANEL_TAIL_LINES));
  // A settled peek is deliberately a one-line acknowledgement only. The
  // permanent subagent transcript block owns the result/preview; keeping
  // old live deltas here duplicates information and wastes vertical space.
  const lines = sub.status === "running" ? (tail?.lines ?? []).slice(-maxLines) : [];
  const freeze = panelFreezeLine(sub);
  return (
    // Deliberately frameless: this is volatile footer-adjacent chrome, not
    // a transcript card. The old border/padding consumed four empty rows.
    <Box flexDirection="column" width={Math.max(16, width)} paddingX={1}>
      <Text color={sub.status === "running" ? theme.accent : theme.dim} bold>{panelHeader(sub, tail, now)}</Text>
      {sub.status === "running" && lines.length > 0 && lines.map((line) => (
        <Text key={line.id} color={line.text.startsWith("✗") ? theme.err : line.text.startsWith("●") ? theme.fg : theme.dim} wrap="truncate">
          {"  "}{line.text}
        </Text>
      ))}
      {freeze !== "" && <Text color={freeze.startsWith("✓") ? theme.ok : theme.err}>{freeze}</Text>}
    </Box>
  );
}
