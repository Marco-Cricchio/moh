import { useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentSession } from "@moh/core";
import { projectTurns, type TurnView } from "./turns";

/** ~30fps coalescing window (docs/tui-style-guide.md §1 Q3). */
const FLUSH_MS = 33;

export interface SessionState {
  /** Projected turn views. */
  turns: TurnView[];
  /** Turn count for the dev status line. */
  turnCount: number;
  /** True while a turn is in flight (including one being steered away). */
  pending: boolean;
  /** Raw log length (dev status line). */
  eventCount: number;
}

/**
 * Subscribes to the session's event log and re-projects the turn list,
 * coalescing bursts of events (e.g. word-by-word deltas) into one render
 * per ~33ms frame so streaming never flickers. Unsubscribes on unmount or
 * session switch (the events async-iterator is `return()`ed).
 */
export function useSessionState(session: AgentSession): SessionState {
  const [state, setState] = useState<SessionState>(() => project(session.history()));
  const buffered = useRef<AgentEvent[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setState(project(session.history()));
    let stopped = false;

    const flush = () => {
      timer.current = null;
      if (stopped || buffered.current === null) return;
      setState(project(buffered.current));
      buffered.current = null;
    };

    const schedule = () => {
      if (timer.current === null) timer.current = setTimeout(flush, FLUSH_MS);
    };

    const consume = async () => {
      try {
        for await (const event of session.events) {
          // Keep a full snapshot: deltas accumulate, so the projection needs
          // the whole log each time (history() is a cheap array copy).
          buffered.current = session.history();
          schedule();
        }
      } catch {
        // A closed iterator just ends the subscription.
      }
    };
    void consume();

    return () => {
      stopped = true;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      buffered.current = null;
    };
  }, [session]);

  return state;
}

function project(history: AgentEvent[]): SessionState {
  const turns = projectTurns(history);
  return {
    turns,
    turnCount: turns.length,
    pending: turns.at(-1)?.phase === "streaming",
    eventCount: history.length,
  };
}
