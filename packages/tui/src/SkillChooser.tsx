import React, { useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { formatSkillCommand, skillRecommendations, type SkillRoutingConfig, type TrackerIssue } from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

export interface SkillChooserProps {
  issue: TrackerIssue;
  routing?: SkillRoutingConfig;
  /** Sets the composer draft; it deliberately does not submit a turn. */
  onChoose: (prefill: string) => void;
  /** Returns to the Frontier while retaining the completed claim. */
  onBack: () => void;
  /** Exits the flow with the issue claimed but no composer change. */
  onJustClaim: () => void;
}

/** Post-claim workflow chooser. It only projects labels already on the issue. */
export function SkillChooser({ issue, routing, onChoose, onBack, onJustClaim }: SkillChooserProps) {
  const theme = useTheme();
  const recommendations = useMemo(() => skillRecommendations(issue.labels, routing), [issue.labels, routing]);
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.escape) return onBack();
    if (input === "j") return onJustClaim();
    if (key.upArrow) return setCursor((value) => Math.max(0, value - 1));
    if (key.downArrow) return setCursor((value) => Math.min(recommendations.length - 1, value + 1));
    if ((key.return || input === "return") && recommendations[cursor]) {
      onChoose(formatSkillCommand(recommendations[cursor]!, issue.id));
    }
  });

  return (
    <Dialog title=" choose workflow " color={theme.purple}>
      <Text wrap="truncate-end">{`#${issue.id} ${issue.title}`}</Text>
      <Text> </Text>
      {recommendations.length === 0 ? (
        <Dim>no workflow suggestion for these labels</Dim>
      ) : recommendations.map((route, index) => (
        <Text key={route.label} inverse={index === cursor} wrap="truncate-end">
          <Text color={index === cursor ? theme.accent : undefined}>{` ${formatSkillCommand(route, issue.id)} `}</Text>
          <Dim>{`[${route.label}]`}</Dim>
        </Text>
      ))}
      <Text> </Text>
      <Dim>{recommendations.length ? "↑↓ move · enter prefill · j Just claim · esc back" : "j Just claim · esc back"}</Dim>
    </Dialog>
  );
}
