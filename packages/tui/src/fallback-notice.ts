/**
 * ADR-0012 (#234): fallback chains are automatic; a stop firing mid-call
 * must be visible, not silent (the ADR-0005 spirit). The route engine
 * emits a `fallback` event (from/to/reason) through the session log;
 * this watcher turns it into a toast. Event-driven by design — a plain
 * model-change heuristic would false-positive on legitimate multi-model
 * turns.
 */
import type { AgentEvent } from "@moh/core";

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
  return (event) =>
    event.type === "fallback" ? fallbackToastText(event.from, event.to, event.reason) : null;
}
