import type { ReasoningStreamEvent } from "./types";

/**
 * The stream's reasoning lifecycle folds into *parts*: `reasoning_start`
 * opens one, `reasoning_delta` appends to it, `reasoning_end` closes it.
 * Two rules belong to the channel's contract, not to any consumer:
 *
 * 1. **A part that carries no text is dropped.** A provider may announce a
 *    part per stream chunk (`ai-sdk` maps every `reasoning-start` part of
 *    its `fullStream`), so dozens of empty parts per call are ordinary.
 * 2. **Several parts are joined with a blank line** (`"\n\n"`), which is how
 *    they render as one thinking block.
 *
 * The log applies both rules (`session/agent-loop.ts` persists one
 * `reasoning` event per non-empty part, and the settled projection joins
 * them), and so must every live consumer: a client that invents its own
 * separator shows text the log never holds, and — because promotion into
 * native scrollback is append-only — cannot take it back (#993: the TUI
 * added `"\n\n"` per `reasoning_start`, 637 per real call, and printed
 * hundreds of blank rows).
 *
 * The fold is pure and state-in/state-out, so consumers can replay any
 * lifecycle shape and compare.
 */
export interface ReasoningParts {
  /** Texts of the parts closed so far, in arrival order, empties dropped. */
  readonly parts: readonly string[];
  /** Text of the part currently open (`""` when none). */
  readonly open: string;
}

export const EMPTY_REASONING_PARTS: ReasoningParts = { parts: [], open: "" };

/** One lifecycle step. Events other than the reasoning trio return the
 * state untouched, so a consumer can fold a mixed stream. */
export function foldReasoningParts(state: ReasoningParts, event: ReasoningStreamEvent): ReasoningParts {
  switch (event.type) {
    case "reasoning_start":
      // An unterminated part is discarded, exactly as the log does: a part
      // is only kept by the `reasoning_end` that closes it.
      return { parts: state.parts, open: "" };
    case "reasoning_delta":
      return { parts: state.parts, open: state.open + event.text };
    case "reasoning_end":
      return state.open ? { parts: [...state.parts, state.open], open: "" } : { parts: state.parts, open: "" };
    default:
      return state;
  }
}

/** Folds a whole lifecycle: the display text of a sequence of parts. */
export function foldReasoningText(events: Iterable<ReasoningStreamEvent>): string {
  let state = EMPTY_REASONING_PARTS;
  for (const event of events) state = foldReasoningParts(state, event);
  return reasoningPartsText(state);
}

/** Display text of the fold so far: the open part keeps growing while it
 * streams, and a part becomes permanent when the `reasoning_end` that
 * closes it arrives. Between lifecycle edges the text only grows — which is
 * what lets a client promote rows of an open reasoning block into
 * append-only scrollback. (A part left open by a later `reasoning_start` is
 * dropped here exactly as the log drops it, so nothing a client promotes
 * can be text the settled transcript will not hold; a client that already
 * printed rows sees its source shrink, which its own seal guard handles.) */
export function reasoningPartsText(state: ReasoningParts): string {
  return (state.open ? [...state.parts, state.open] : state.parts).join("\n\n");
}
