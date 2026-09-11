import { useEffect, useRef, useState } from "react";
import type { AgentSession } from "@moh/core";

/**
 * #liveness prototype winner (variant C): live tool-progress projection.
 * Subscribes to the session's live channel and tracks the open tool
 * blocks' partial output — a scrolling tail (last TAIL_CAP lines) per
 * callId, shown dim inside the volatile running block. Chunks arrive via
 * ToolContext.onProgress; they are ephemeral (never in the log) and the
 * settled block keeps its usual result cap, so scrollback determinism
 * (#194) is untouched.
 *
 * One state update per ~33ms frame, same coalescing as useLiveReasoning.
 */

/** Max lines kept in a running block's tail; older lines scroll out. */
export const TOOL_TAIL_CAP = 9;

export type ToolTailMap = Map<string, string[]>;

export function useToolProgress(session: AgentSession | null, pending: boolean): ToolTailMap {
  const [state, setState] = useState<ToolTailMap>(new Map());
  const current = useRef<ToolTailMap>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!session) return;
    setState(new Map());
    current.current = new Map();
    let stopped = false;

    const flush = () => {
      timer.current = null;
      if (stopped) return;
      setState(new Map(current.current));
    };
    const schedule = () => {
      if (timer.current === null) timer.current = setTimeout(flush, 33);
    };

    const off = session.onLiveEvent((event) => {
      if (event.type !== "tool_progress") return;
      const map = current.current;
      const prev = map.get(event.callId) ?? [];
      const line = event.chunk.replace(/\r/g, "").replace(/\n+$/, "");
      const next = [...prev, ...line.split("\n").filter((l) => l.trim() !== "")].slice(-TOOL_TAIL_CAP);
      map.set(event.callId, next);
      schedule();
    });

    return () => {
      stopped = true;
      off();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [session]);

  // Turn boundary: the volatile tails are transient — a settled tool's
  // result lives in the log, so the map must not leak across turns.
  useEffect(() => {
    if (pending) return;
    current.current = new Map();
    setState(new Map());
  }, [pending]);

  return state;
}
