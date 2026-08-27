import { useEffect, useRef, useState } from "react";
import type { AgentSession } from "@moh/core";
import { capReasoningText } from "./transcript";

/**
 * #253: live provider-reasoning projection. Subscribes to the session's
 * ephemeral live channel (`onLiveEvent`) and tracks the open reasoning
 * block while the model thinks; deltas are coalesced into one state
 * update per ~33ms frame (docs/tui-style-guide.md §1 Q3) and the display
 * buffer is capped exactly like settled reasoning blocks (64 KiB, the
 * full text always lands in the session log instead).
 *
 * The block stays visible (frozen) after `reasoning_end` until the
 * completed `reasoning` AgentEvent — or the call/turn boundary — lands in
 * the persisted log, so the volatile block hands over to the settled,
 * model-labelled block without a gap or a duplicate.
 */
export interface LiveReasoningState {
  text: string;
  /** True while the provider is still emitting reasoning deltas. */
  active: boolean;
}

export function useLiveReasoning(session: AgentSession | null, pending: boolean): LiveReasoningState | null {
  const [state, setState] = useState<LiveReasoningState | null>(null);
  const current = useRef<LiveReasoningState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!session) return;
    setState(null);
    current.current = null;
    let stopped = false;

    const flush = () => {
      timer.current = null;
      if (stopped || current.current === null) return;
      setState({ ...current.current });
    };
    const schedule = () => {
      if (timer.current === null) timer.current = setTimeout(flush, 33);
    };
    const clear = () => {
      current.current = null;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setState(null);
    };

    const off = session.onLiveEvent((event) => {
      const prev = current.current ?? { text: "", active: true };
      if (event.type === "reasoning_start") {
        current.current = { text: "", active: true };
      } else if (event.type === "reasoning_delta") {
        current.current = { text: capReasoningText(prev.text + event.text), active: true };
      } else if (event.type === "reasoning_end") {
        current.current = { text: prev.text, active: false };
      }
      schedule();
    });
    // The volatile block ends its life when the settled block (or the
    // call/turn boundary) reaches the persisted log. This is a second
    // async iterator over session.events, concurrent with the ones in
    // session-bridge/App — supported by design (EventLog listener fan-out).
    const consume = async () => {
      try {
        for await (const event of session.events) {
          if (stopped) return;
          if (
            event.type === "reasoning" || event.type === "model_call" || event.type === "error"
            || event.type === "cancelled" || event.type === "user_message"
          ) {
            clear();
          }
        }
      } catch {
        // closed iterator: the subscription simply ends
      }
    };
    void consume();
    return () => {
      stopped = true;
      off();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return pending ? state : null;
}
