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
   Amended (#947): a failed call's `{0,0}` is never a measurement — the trigger
   reads the last *non-failed* one — and a turn that ends with a provider
   `context_length` error arms the same post-turn producer directly (guard and
   threshold bypassed: the provider's "does not fit" outranks the arithmetic).
   Still one producer, still post-turn; nothing compacts inline.
2. **Tail policy (amended #949): the window wins; whole turns stay the preference.**
   Originally: "10 turns AND ≤ 25% of the window", with `DEFAULT_TAIL_TURNS` a hard
   floor ("never below"). That floor made compaction structurally unreachable for a
   log whose turns are few and gigantic — a 3-turn session at 253k measured tokens
   never compacted, and the shrink loop was dead code at default settings. Restated:
   the tail is a **contiguous verbatim suffix** and `tailTurns` (default 10) is a
   *preference*, never a floor. One rule for the auto path and the forced path:
   (1) candidate = the last `tailTurns` whole turns; (2) while the span exceeds 25%
   of the window and more than one whole turn is left, the oldest tail turn is left
   out; (3) **the last turn is protected**: it stays whole while it fits
   `window − 8k` (the fitting reserve), even if it alone exceeds the 25%; (4) only
   when the last turn alone exceeds `window − 8k` is the cut taken **inside** it —
   the largest legal suffix under the ceiling, or the last legal boundary when none
   fits. A ceiling never produces a refusal. Guarantee: *a contiguous verbatim
   tail — the last turn whole while it fits the model's window, the turns before it
   while they stay under ~25% of it.* In healthy logs behaviour is identical to the
   pre-#949 rule; the intra-turn cut only starts where the old answer was
   "nothing to compact".

   **Legal boundary (protocol constraint, not policy).** The replayed tail never
   begins with a `tool_result` and never splits a `tool_call`/`tool_result` pair:
   `replayMessages` repairs only unanswered calls (#237) and filters only results
   of *discarded* calls (#371), so an orphan result at the head would reach the
   provider without its call. Allowed first events: `user_message`,
   `assistant_delta`, `reasoning`, `tool_call`. The intra-turn cut needs the
   catalog window: an unknown window (0) keeps the bare turn-count preference —
   a fabricated fallback must not legalize a cut.

   **Accepted cost.** In the extreme case (a single turn larger than the window)
   even that turn's `user_message` lands in the summary. No written promise is
   broken — covered turns' user messages were already summarized — but it is a
   real change for the worst case.
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
   **Extended (#949): a structural refusal is never silent.** When the tail
   policy finds nothing foldable, the producer appends a visible
   `compaction_skipped` chrome event — typed reason (`too_few_turns` |
   `no_covered_turns` | `last_turn_exceeds_window`) plus the numbers that justify
   the skip (`turns`, `measuredTokens`, `window`, optional `tailTokens`) — one
   per new measurement, no sticky chip. "Even the minimal cut cannot reach
   `window − reserve`" is *not* a skip (we do compact): it is recorded on the
   marker as a flag, the `keptByFloor` precedent. The clients name the exits:
   `moh compact` prints a hint line on refusal, `moh run` adds one after a
   `context_length` failure, and the TUI's context_length hint stops promising
   `/compact` when a `compaction_skipped` follows the newest marker
   (deterministic projection).
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
