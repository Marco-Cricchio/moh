import { useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentSession } from "@moh/core";
import { projectSidebar, type SidebarState } from "./sidebar";

/** ~30fps coalescing window (docs/tui-style-guide.md §1 Q3). */
const FLUSH_MS = 33;

export interface SessionState {
  /** Raw append-only log, used by the semantic transcript projection. */
  events: AgentEvent[];
  /** Turn count for the dev status line. */
  turnCount: number;
  /** True while a turn is in flight (including one being steered away). */
  pending: boolean;
}

/**
 * Subscribes to the session's event log and re-projects the turn list,
 * coalescing bursts of events (e.g. word-by-word deltas) into one render
 * per ~33ms frame so streaming never flickers. Unsubscribes on unmount or
 * session switch (the events async-iterator is `return()`ed).
 */
export function useSessionState(session: AgentSession): SessionState {
  return useProjected(session, projectSessionState, () => projectSessionState(session.history()));
}

function projectSessionState(history: AgentEvent[]): SessionState {
  let turnCount = 0;
  let pending = false;
  for (const event of history) {
    if (event.type === "user_message") { turnCount += 1; pending = true; }
    if (event.type === "done" || event.type === "error" || event.type === "cancelled") pending = false;
  }
  return { events: history, turnCount, pending };
}

const EMPTY_SIDEBAR: SidebarState = { activity: [], tokens: { contextIn: 0, totalOut: 0, calls: 0 }, turnCount: 0 };

/**
 * Bottom-status feed (#183): the same coalesced event projection as
 * `useSessionState`, projecting activity/token/turn context.
 * A null session (home screen) yields the empty state.
 */
export function useSidebarState(session: AgentSession | null): SidebarState {
  return useProjected(session, projectSidebar, () => (session ? projectSidebar(session.history()) : EMPTY_SIDEBAR));
}

function useProjected<T>(session: AgentSession | null, project: (history: AgentEvent[]) => T, initial: () => T): T {
  // React re-runs the useState initializer on every render; snapshot the
  // log once, or every render pays a full history() copy.
  const initialRef = useRef<T | null>(null);
  if (initialRef.current === null) initialRef.current = initial();
  const [state, setState] = useState<T>(initialRef.current);
  const projectRef = useRef(project);
  projectRef.current = project;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    if (!session) {
      // Home screen: drop the previous session's projection and its subscription.
      setState(projectRef.current([]));
      return;
    }
    setState(projectRef.current(session.history()));
    let stopped = false;

    const flush = () => {
      timer.current = null;
      if (stopped || !dirty.current) return;
      dirty.current = false;
      setState(projectRef.current(session.history()));
    };

    const schedule = () => {
      if (timer.current === null) timer.current = setTimeout(flush, FLUSH_MS);
    };

    // One iterator per subscription: returning it on cleanup is what
    // removes the EventLog listener (a bare stopped flag would leave the
    // loop — and the retained session — alive after unmount).
    const iterator = session.events[Symbol.asyncIterator]();
    const consume = async () => {
      try {
        while (!stopped) {
          const { done } = await iterator.next();
          if (done) break;
          dirty.current = true;
          schedule();
        }
      } catch {
        // A closed iterator just ends the subscription.
      }
    };
    void consume();

    return () => {
      stopped = true;
      void iterator.return?.();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      dirty.current = false;
    };
  }, [session]);

  return state;
}
