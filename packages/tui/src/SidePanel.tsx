import React, { useCallback, useEffect, useState } from "react";
import { Box, Text } from "ink";
import { projectFrontier, type TrackerBackend } from "@moh/core";
import { useTheme } from "./themes";
import { Dim, truncate } from "./ui";
import {
  SIDEBAR_BORDER_ROWS,
  SIDEBAR_SLACK_ROWS,
  TOKENS_ROWS,
  WORKFLOW_ROWS,
  activityWindow,
  contextFraction,
  sidebarActivityBudget,
  tokenBar,
  type SidebarState,
} from "./sidebar";

/**
 * The right sidebar sections (issue #118, spec decision 6 / slice T6):
 * Activity (recent tool calls + subagent state, internally windowed),
 * Workflow (frontier projection: claimed/ready/blocked) and Tokens (context
 * usage bar + counts). Workflow and Tokens stay anchored to the panel
 * bottom; only the Activity window absorbs height changes. The panel never
 * grows — windowing is internal.
 */
export interface SidePanelProps {
  /** Live Activity/Tokens feed (App owns the single event subscription). */
  state: SidebarState;
  /** Wayfinder tracker; null when workflow is off (section says so). */
  backend: TrackerBackend | null;
  workflowOn: boolean;
  /** Total panel rows (bodyRows from the viewport seam). */
  rows: number;
  /** Inner width in columns (panel width minus borders and padding). */
  width: number;
}

type FrontierView = ReturnType<typeof projectFrontier>;
type FrontierLoad = { kind: "loading" } | { kind: "error" } | { kind: "ready"; frontier: FrontierView };

export function SidePanel({ state, backend, workflowOn, rows, width }: SidePanelProps) {
  const theme = useTheme();
  const [load, setLoad] = useState<FrontierLoad>({ kind: "loading" });

  // The frontier refreshes on mount, on backend change, and at every new
  // turn — claims made mid-session (by the model or the frontier overlay)
  // show up without reopening anything.
  const reload = useCallback(() => {
    if (!backend) return setLoad({ kind: "error" });
    setLoad({ kind: "loading" });
    void backend
      .list()
      .then((issues) => setLoad({ kind: "ready", frontier: projectFrontier(issues) }))
      .catch(() => setLoad({ kind: "error" }));
  }, [backend]);
  useEffect(reload, [reload, state.turnCount]);

  // Activity window: two-pass so the `↑ N more` indicator never grows the panel.
  const budget = sidebarActivityBudget(rows);
  const first = activityWindow(state.activity, budget);
  const win = first.hidden > 0 ? activityWindow(state.activity, budget - 1) : first;

  const tokens = state.tokens;
  const pct = Math.round(contextFraction(tokens.contextIn) * 100);
  const bar = tokenBar(contextFraction(tokens.contextIn), Math.max(4, width - 5));

  return (
    <Box flexDirection="column" height={Math.max(0, rows - SIDEBAR_BORDER_ROWS - SIDEBAR_SLACK_ROWS)}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Text bold underline>Activity</Text>
      {win.hidden > 0 && <Dim>{`↑ ${win.hidden} more`}</Dim>}
      {win.visible.map((item, i) =>
        item.kind === "tool" ? (
          <Text key={`t${i}`} wrap="truncate-end">
            <Text color={item.ok === null ? theme.dim : item.ok ? theme.ok : theme.warn} bold>{` ${mark(item.ok)}`}</Text>
            <Text color={theme.fg}>{` ${item.name} `}</Text>
            <Dim>{truncate(item.detail, Math.max(0, width - item.name.length - 4))}</Dim>
          </Text>
        ) : (
          <Text key={`s${i}`} wrap="truncate-end">
            <Text color={theme.purple} bold>{` ${subMark(item.status)}`}</Text>
            <Text color={theme.fg}>{` sub ${truncate(item.name, Math.max(0, width - 9))}`}</Text>
          </Text>
        ),
      )}
      </Box>

      <Box height={WORKFLOW_ROWS} flexDirection="column" flexShrink={0}>
        <Text bold underline>Workflow</Text>
        {!workflowOn && <Dim> off (/workflow on)</Dim>}
        {workflowOn && load.kind === "loading" && <Dim> loading tracker…</Dim>}
        {workflowOn && load.kind === "error" && <Text color={theme.warn}> ⚠ tracker unavailable</Text>}
        {workflowOn && load.kind === "ready" && (
          <Text wrap="truncate-end">
            <Text color={theme.warn}>{`◉ ${load.frontier.inProgress.length}`}</Text>
            <Dim>claimed · </Dim>
            <Text color={theme.ok}>{`○ ${load.frontier.ready.length}`}</Text>
            <Dim>ready · </Dim>
            <Text color={theme.dim}>{`⊘ ${load.frontier.blocked.length}`}</Text>
            <Dim>blocked</Dim>
          </Text>
        )}
      </Box>

      <Box height={TOKENS_ROWS} flexDirection="column" flexShrink={0}>
        <Text bold underline>Tokens</Text>
        <Text color={theme.accent} wrap="truncate-end">{` ${bar} ${pct}%`}</Text>
        <Text color={theme.dim} wrap="truncate-end">{` ${tokens.contextIn.toLocaleString()} in · ${tokens.totalOut.toLocaleString()} out · ${tokens.calls} calls`}</Text>
      </Box>
    </Box>
  );
}

function mark(ok: boolean | null): string {
  return ok === null ? "…" : ok ? "✓" : "✗";
}

function subMark(status: "running" | "done" | "error" | "cancelled"): string {
  return status === "running" ? "…" : status === "done" ? "✓" : "✗";
}
