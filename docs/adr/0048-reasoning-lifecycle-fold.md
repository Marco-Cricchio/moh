# ADR-0048: The reasoning lifecycle folds once — a client never invents its own text

Status: accepted · Date: 2026-09-25 · Issue: #993 · Related: #240, #253, #242, #329, #972/#973 (ADR-0047), ADR-0004 (public surface)

## Context

Provider reasoning reaches clients two ways: the persisted `reasoning`
AgentEvents (one per completed part, written by the loop) and the ephemeral
live channel (`session.onLiveEvent`) that relays the raw lifecycle —
`reasoning_start` / `reasoning_delta` / `reasoning_end` — while the model
thinks (`#253`).

The lifecycle is **provider-shaped, not consumer-shaped**: a provider may
announce a part per stream chunk. Measured on a real call through the
fallback chain (2026-09-25): **637 `reasoning_start` against 969 deltas**,
most starts followed by an empty delta. The chain that produces that shape is
in the wire dialect itself: `openrouter-chat.ts`'s `mergeReasoning` closes its
open block before the first text part and reopens it when reasoning resumes,
so any interleaving of reasoning and reply text is one announced part per
run.

The core has always folded this correctly for the log:
`agent-loop.#consumeReasoningEvent` keeps a part only when the
`reasoning_end` that closes it carries text, and the settled projection joins
the kept parts with one blank line.

The TUI's live channel did not. `live-reasoning.ts` appended `"\n\n"` on
**every** `reasoning_start` — one empty part per chunk became one phantom
blank row — and the live buffer reached `srcLen=2898` with `srcLines=1241`,
a wall of newlines the log never holds. Because the reasoning head chain
(#329) promotes the open block's rows into `<Static>` — append-only, one row
per frame — the client printed **497 consecutive chunks made of nothing but
blank rows**, shoving the reply out of the visible area and leaving native
scrollback littered with empty space (measured: 1303 of 1452 pushed rows
blank at 100×24; 1270 of 1389 in tmux at 149×40, the owner's geometry).

The TUI is the only client on that channel today, but the failure mode is the
channel's, not the TUI's: any client that re-derives the text from the
lifecycle can invent the same phantom content, and it cannot take it back
(appended scrollback is not revisable).

## Decision

**The fold of the reasoning lifecycle is the channel's contract, and it lives
in the core once.**

`packages/core/src/reasoning-parts.ts` exports `foldReasoningParts`,
`reasoningPartsText`, `foldReasoningText`, `EMPTY_REASONING_PARTS` and the
`ReasoningParts` state, under two rules that match the log exactly:

1. **A part that carries no text is dropped.** An announcement per stream
   chunk is ordinary and contributes nothing.
2. **Kept parts join with one blank line** (`"\n\n"`), which is how they
   render as one thinking block.

An unterminated part is visible while it streams and dropped when the call
settles — the log's own behavior, so nothing a client promotes can become
text the settled transcript will not hold.

`agent-loop.ts` folds through the same function (its per-part bookkeeping is
now `#reasoning: ReasoningParts`), and `useLiveReasoning` consumes it instead
of keeping its own separator rule. A client's live buffer is therefore *the
persisted text plus the part still open*, for every lifecycle shape: one part
per call, one per chunk, interleaved empties, deltas without a start, text
containing blank lines.

### Public surface (amends ADR-0004)

The five exports above join the public surface for the same reason the pricing
seam is public (ADR-0004 amendment, #955): the live channel is already a
client door (`onLiveEvent`, `ReasoningStreamEvent`), and a client that
re-derives its own fold is exactly the client that forks the contract. The
rule is one pure function; exposing it is what makes "one fold" checkable
from outside the core.

## Consequences

- The live channel can no longer show text the log will not hold. Reasoning
  display is unchanged for the common one-part-per-call provider, and a
  chatty provider no longer pays for its announcement rate with blank rows.
- The replay of a real call's live lifecycle now produces the settled text
  byte for byte; a *fuzz* over lifecycle shapes (hand-written plus
  randomized, empties and unterminated parts included) asserts the parity,
  so a future change to either side fails in one test rather than in a user's
  scrollback.
- The wire dialect's announcement rate is now explicitly **not** a contract
  the core promises consumers to control. Whether `mergeReasoning` should
  coalesce one reasoning run into one announced part is a separate decision
  (noted on #993); it does not change what the log persists.

## Alternatives rejected

- **Patch the TUI's separator rule only** (`if (prev.text && !prev.text.endsWith("\n\n"))`).
  It fixes the observed symptom for one announcement pattern while leaving the
  rule duplicated in a client: the next consumer, or the next shape, re-opens
  the bug — and the shape is provider-determined, so "the next shape" is a
  routine release event.
- **Coalesce announcements in the wire adapter** (never emit a `start`
  without a following non-empty delta). It changes the event contract for
  every provider to hide a consumer bug, and the announcement rate is
  meaningful information for a client that wants to know the provider
  restarted its reasoning block.
- **Make the promotion drop blank rows.** The blank rows are real once the
  live text is right (paragraph breaks inside reasoning), and the promotion
  is not the layer that decides what the text is.
