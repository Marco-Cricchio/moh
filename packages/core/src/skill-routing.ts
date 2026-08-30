/**
 * Label-guided workflow suggestions for a claimed tracker issue (#357).
 * This is deliberately a pure projection: it never reads issue contents or
 * guesses whether work is human-in-the-loop.
 */
export interface SkillRouteOverride {
  /** Slash command to add or replace a label mapping. */
  command?: string;
  /** Higher values are shown first. Built-in state labels start above categories. */
  priority?: number;
  /** Removes a built-in mapping (or suppresses a project mapping). */
  disabled?: boolean;
  /** Short intent not represented by the command and issue reference. */
  suffix?: string;
}

export interface SkillRoutingConfig {
  labels?: Record<string, SkillRouteOverride>;
}

export interface SkillRecommendation {
  label: string;
  command: string;
  suffix?: string;
}

interface BuiltinRoute extends SkillRecommendation {
  priority: number;
}

// State labels deliberately rank above category labels. A wayfinder task is
// an explicit human-in-the-loop route: `/wizard` only prepares the checklist;
// it never attempts the human work itself.
const BUILTIN_ROUTES: readonly BuiltinRoute[] = [
  { label: "needs-triage", command: "/triage", priority: 200 },
  { label: "ready-for-agent", command: "/implement", priority: 200 },
  { label: "wayfinder:research", command: "/research", priority: 200 },
  { label: "wayfinder:prototype", command: "/prototype", priority: 200 },
  { label: "wayfinder:grilling", command: "/grilling", priority: 200, suffix: "with /domain-modeling" },
  { label: "wayfinder:task", command: "/wizard", priority: 200 },
  { label: "bug", command: "/diagnosing-bugs", priority: 100 },
  { label: "enhancement", command: "/implement", priority: 100 },
];

/** Returns matching routes in stable rank then label order. */
export function skillRecommendations(labels: readonly string[], config: SkillRoutingConfig = {}): SkillRecommendation[] {
  const present = new Set(labels);
  const builtins = new Map(BUILTIN_ROUTES.map((route) => [route.label, route]));
  const candidates: Array<BuiltinRoute> = [];

  for (const label of present) {
    const builtin = builtins.get(label);
    const override = config.labels?.[label];
    if (override?.disabled) continue;
    const command = override?.command ?? builtin?.command;
    if (!command) continue;
    candidates.push({
      label,
      command,
      priority: override?.priority ?? builtin?.priority ?? 100,
      ...((override?.suffix ?? builtin?.suffix) ? { suffix: override?.suffix ?? builtin?.suffix } : {}),
    });
  }

  return candidates
    .sort((a, b) => b.priority - a.priority || a.label.localeCompare(b.label))
    .map(({ label, command, suffix }) => suffix ? { label, command, suffix } : { label, command });
}

/** The minimal, unsent composer text for a selected route. */
export function formatSkillCommand(route: SkillRecommendation, issueId: string): string {
  return [route.command, `#${issueId}`, route.suffix].filter(Boolean).join(" ");
}
