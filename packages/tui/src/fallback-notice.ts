/**
 * ADR-0012 (#234): fallback chains are automatic; a stop firing mid-turn
 * must be visible, not silent (the ADR-0005 spirit). This watcher is a
 * pure event reducer: feed it session events in order, get a toast text
 * back exactly when a model call switches models within a turn — the
 * observable signature of a fallback (retries on the same endpoint do
 * not change the model).
 */
import type { AgentEvent } from "@moh/core";

export type FallbackWatcher = (event: AgentEvent) => string | null;

export function createFallbackWatcher(): FallbackWatcher {
  let lastModel: string | undefined;
  return (event) => {
    if (event.type === "model_call") {
      const notice = lastModel !== undefined && event.model !== lastModel
        ? `fallback → ${event.model}`
        : null;
      lastModel = event.model;
      return notice;
    }
    // A new turn (or an explicit /model switch) re-baselines the model.
    if (event.type === "user_message" || event.type === "model_switched" || event.type === "done") {
      lastModel = undefined;
    }
    return null;
  };
}
