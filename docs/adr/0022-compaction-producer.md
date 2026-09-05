# ADR-0022: compaction producer

Status: accepted · Date: 2026-09-03 · Parent: issue #462 (wayfinder #461, continuity)

## Context

Replay honors `compaction` markers (`{ type: "compaction"; summary; upTo }`,
`core/src/types.ts`; `replayMessages()` in `session-store.ts` uses the newest
marker's summary in place of the events it covers) but nothing ever writes them:
long sessions never compact. A `CompactionRunner` was built standalone (#466,
`core/src/compaction.ts`: threshold check, tail selection, `compactNow()`,
`#lastSeenCallIndex` anti-loop guard) but is not wired — `SessionConfig.compaction`
is declared yet never passed through, no session-side wiring exists, and the
integration tests are red by design.

Decisions closed in grilling (#462): automatic threshold trigger plus an explicit
`/compact`, both through the same producer.

## Decision

1. **One producer, post-turn.** `CompactionRunner` (MemoryRunner pattern) owns all
   compaction; `AgentSession` never compacts inline. Auto-trigger: the last
   `model_call`'s measured `inputTokens` crosses 80% of the active model's context
   window (catalog-derived; absolute-token fallback when the window is unknown).
2. **Tail policy: 10 turns AND ≤ 25% of the window.** The tail grows backwards
   until it spans at least `DEFAULT_TAIL_TURNS = 10` turns **and** at most ~25% of
   the context window (token-estimated). Both conditions hold; the bare
   turn-count rule is retired.
3. **Forced compaction always compacts.** `/compact` (TUI, turn-scoped: it sets a
   flag, the producer runs at the turn boundary) and `moh compact` (CLI) invoke the
   same `compactNow()` regardless of the threshold; the threshold gates only the
   auto-trigger.
4. **`moh compact` works on closed files and does not consume them.** It opens the
   target session (most recent of the project, or `--session <file>`), runs the
   producer, appends the marker, closes — **without** appending `session_resumed`.
   Compacting is not resuming: the session stays suggestible in the picker. This
   is the deliberate exception to ADR-0021's "sole marker of consumption" — the
   marker stays the sole consumption marker; compaction simply never marks
   consumption.
5. **Dedicated summarizer.** `createCompactionSummarizer`, a dedicated child
   session sharing the maintenance-extractor discipline (#339: no tools, no
   subagents) but with its own prompt: task state, never durable facts (those
   belong to Memory), chained on the previous summary.
6. **Failure: fail-silent with a visible warning.** A failed compaction appends
   nothing and retries at the next turn boundary while still above threshold —
   with **backoff** when two consecutive attempts fail to get below threshold
   (added to the existing `#lastSeenCallIndex` guard). The TUI shows a sticky
   banner ("context running low — compaction failed, retrying next turn") until a
   retry succeeds or the user compacts. Success surfaces as a discreet chrome
   event and indicator (the `memory_updated` pattern); the transcript already
   renders `◈ context compacted · N events`.
7. **On by default.** Auto-compaction is active with zero config; `SessionConfig.compaction`
   (already declared) becomes the override point (threshold, tail, custom
   summarizer).
8. **The log stays append-only and replay deterministic.** Nothing is ever
   truncated or mutated; after a marker the live prompt is rebuilt through the
   same replay path resume uses, and a fresh measurement — not the stale one — may
   re-trigger.

## Consequences

- Wiring is the bulk of the implementation: instantiate the runner in
  `AgentSession` (alongside MemoryRunner), thread `compaction` through
  `from-config.ts`, add `/compact` and `moh compact`, surface the sticky banner.
- Off-by-default costs nothing to users who never care; on-by-default costs a
  summary call per crossing of 80% — accepted, as compaction is a completeness
  condition of the continuity killer feature.
- A wrong summary is recoverable only by forking the session before the marker;
  summaries are user-visible in the transcript to make this inspectable.
