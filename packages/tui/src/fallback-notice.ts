/**
 * ADR-0012 (#234): fallback chains are automatic; a stop firing mid-call
 * must be visible, not silent (the ADR-0005 spirit). The route engine
 * emits a `fallback` event (from/to/reason) through the session log;
 * this watcher turns it into a toast. Event-driven by design — a plain
 * model-change heuristic would false-positive on legitimate multi-model
 * turns.
 *
 * ADR-0050 (#974): one formatter, shared with the footer and the `/model`
 * header — the notice names the pair exactly as every other surface does.
 */
import { formatModelPair, type AgentEvent } from "@moh/core";

export type FallbackWatcher = (event: AgentEvent) => string | null;

const REASON_LABELS: Record<string, string> = {
  quota_exhausted: "quota exhausted",
  rate_limited: "rate limited",
  overloaded: "overloaded",
  network: "network error",
};

export function fallbackToastText(from: string, to: string, reason: string): string {
  return `${REASON_LABELS[reason] ?? reason} on ${from} → ${to}`;
}

export function createFallbackWatcher(): FallbackWatcher {
  return (event) => {
    if (event.type !== "route_serving") return null;
    // ADR-0050 §6: a session opening on an inherited serving stop declares
    // how it was born — it reports no change the user watched happen (the
    // subagent chip already shows the child). `previous` names the stop it
    // was serving: the same stop it still serves means nothing moved.
    if (event.previous === event.serving) return null;
    const recovering = event.serving === event.selected;
    return recovering
      ? `recovered ${event.selected}`
      : `using fallback ${formatModelPair(event.selected, event.serving)}`;
  };
}
