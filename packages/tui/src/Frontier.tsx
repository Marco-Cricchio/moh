import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { projectFrontier, type TrackerBackend, type TrackerIssue } from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * The wayfinder frontier panel (#36): a read-only projection of the
 * tracker — claimed (in progress), ready (open + unblocked), blocked —
 * with a single action, claim (`c`). Backends without dependency data
 * (gh/gitlab) degrade to a flat list.
 */
export interface FrontierProps {
  backend: TrackerBackend | null;
  onToast: (message: string) => void;
  onClose: () => void;
  /**
   * Permission seam for the claim action (#36): the panel claims only
   * when it resolves true. The App routes it through the same
n   * PermissionGate modal used for `tracker_claim` tool calls.
   */
  requestClaim?: (issue: TrackerIssue) => Promise<boolean> | boolean;
}

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; issues: TrackerIssue[] };

export function Frontier({ backend, onToast, onClose, requestClaim }: FrontierProps) {
  const theme = useTheme();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [cursor, setCursor] = useState(0);
  const [claiming, setClaiming] = useState(false);

  const reload = useCallback(() => {
    if (!backend) {
      setLoad({ kind: "error", message: "no tracker detected for this project" });
      return;
    }
    setLoad({ kind: "loading" });
    void backend
      .list()
      .then((issues) => setLoad({ kind: "ready", issues }))
      .catch((err: unknown) => setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [backend]);

  useEffect(reload, [reload]);

  const frontier = useMemo(
    () => (load.kind === "ready" ? projectFrontier(load.issues) : null),
    [load],
  );

  // Rows shown in order; grouped when dependency data exists, flat otherwise.
  const rows = useMemo(() => {
    if (!frontier) return [];
    if (!frontier.deps) return [...frontier.inProgress, ...frontier.ready].map((i) => ({ issue: i, group: "" }));
    return [
      ...frontier.inProgress.map((i) => ({ issue: i, group: "in progress" })),
      ...frontier.ready.map((i) => ({ issue: i, group: "ready" })),
      ...frontier.blocked.map((i) => ({ issue: i, group: "blocked" })),
    ];
  }, [frontier]);

  const current = rows[cursor]?.issue;

  useInput((input, key) => {
    if (key.escape || input === "q") return onClose();
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(rows.length - 1, c + 1));
    if ((input === "c" || input === "return") && current && !claiming) {
      if (current.assignees.length > 0) return onToast(`#${current.id} already claimed by ${current.assignees.join(", ")}`);
      setClaiming(true);
      void (async () => {
        try {
          if (requestClaim && !(await requestClaim(current))) {
            onToast(`claim of #${current.id} denied`);
            return;
          }
          await backend?.claim(current.id);
          onToast(`claimed #${current.id}`);
          reload();
        } catch (err: unknown) {
          onToast(`claim failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setClaiming(false);
        }
      })();
    }
  });

  return (
    <Dialog title=" frontier " color={theme.accent} width="62%">
      {load.kind === "loading" && <Dim>loading tracker…</Dim>}
      {load.kind === "error" && (
        <Text color={theme.warn}>{`⚠ tracker unavailable: ${load.message}`}</Text>
      )}
      {load.kind === "ready" && rows.length === 0 && <Dim>no open issues — the frontier is clear</Dim>}
      {load.kind === "ready" &&
        rows.map(({ issue, group }, i) => (
          <Text key={issue.id} inverse={i === cursor}>
            <Text color={i === cursor ? theme.accent : undefined}>{` ${issue.id.padStart(4)} `}</Text>
            {group ? <Dim>{`[${group}] `}</Dim> : null}
            {issue.assignees.length > 0 ? <Text color={theme.warn}>◉ </Text> : <Text color={theme.ok}>○ </Text>}
            {issue.title}
            {issue.blockedBy.length > 0 ? <Dim>{` (blocked by ${issue.blockedBy.map((b) => `#${b}`).join(",")})`}</Dim> : null}
          </Text>
        ))}
      <Text> </Text>
      <Dim>↑↓ move · c claim · esc close{frontier && !frontier.deps ? " · no dependency data: flat list" : ""}</Dim>
    </Dialog>
  );
}
