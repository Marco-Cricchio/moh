import type { AgentEvent } from "@moh/core";

/** One tool invocation as the TUI sees it, paired by `callId`. */
export interface ToolView {
  callId: string;
  name: string;
  args: unknown;
  /** null while the call is in flight, then the result's `ok`. */
  ok: boolean | null;
  /** null until the tool_result event arrives. */
  output: string | null;
}

export type TurnPhase = "streaming" | "done" | "error" | "cancelled";

/** One send→stream→tools→reply cycle, projected from the event log. */
export interface TurnView {
  /** Index of the turn's user_message event in the session log. */
  id: number;
  user: string;
  /** Streaming text accumulated from assistant_delta events. */
  reply: string;
  toolCalls: ToolView[];
  phase: TurnPhase;
  /** Present when phase is "error". */
  error?: { reason: string; message: string };
}

/**
 * Projects the append-only event log into a list of turns (the TUI view
 * model). Pure: same events, same turns. A turn opens on `user_message`,
 * collects deltas/tool calls, and settles on `done` / `error` / `cancelled`;
 * a log that ends mid-turn leaves it `streaming`.
 */
export function projectTurns(events: ReadonlyArray<AgentEvent>): TurnView[] {
  const turns: TurnView[] = [];
  let current: TurnView | null = null;
  const byCallId = new Map<string, ToolView>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    switch (event.type) {
      case "user_message":
        current = { id: i, user: event.text, reply: "", toolCalls: [], phase: "streaming" };
        turns.push(current);
        break;
      case "assistant_delta":
        if (current) current.reply += event.text;
        break;
      case "tool_call": {
        if (!current) break;
        const view: ToolView = { callId: event.callId, name: event.name, args: event.args, ok: null, output: null };
        current.toolCalls.push(view);
        byCallId.set(event.callId, view);
        break;
      }
      case "tool_result": {
        const view = byCallId.get(event.callId);
        if (view) {
          view.ok = event.ok;
          view.output = event.output;
        }
        break;
      }
      case "error":
        if (current) {
          current.phase = "error";
          current.error = { reason: event.reason, message: event.message };
          current = null;
        }
        break;
      case "done":
      case "cancelled":
        if (current) {
          current.phase = event.type;
          current = null;
        }
        break;
      default:
        break; // session_start, permission_*, session_mode, compaction: chrome
    }
  }
  return turns;
}
