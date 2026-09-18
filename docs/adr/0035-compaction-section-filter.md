# ADR-0035: `onCompaction` — extension influence over the summarized transcript

Status: accepted · Date: 2026-09-18 · Parent: wayfinder map #799, ticket #817
Consumer: Jev compaction cut guide (#792)

## Context

Compaction renders the covered events into a compact transcript
(`compactionTranscript`, `packages/core/src/compaction.ts:124`) and hands that string to a
summarizer (`CompactionOptions.summarizer`, a client injection). The summarizer is
replaceable; the **material** it receives is not. No extension can influence which parts of
the session reach it — `appendToPrompt` writes to the turn's prompt, `appendEvent` writes to
the log, and neither is a filter.

The Jev cut guide (#792) wants exactly that influence: a long session's transcript is mostly
exhausted work — long tool results, exploration output, failed attempts — and a semantic
judgment can separate "this turn is settled, its output can go" from "this turn still
carries a decision the conversation will need". Dropping the first kind shrinks every future
summary at no cost to the surviving context.

The risk is obvious and must be designed away: an extension (or a bad judgment inside it)
must never be able to erase a user's message or a ratified decision from the conversation.

## Decision

**Go.** One new optional hook, `onCompaction`, apiVersion bumping to **`1.4`** (additive —
an older runtime ignores it, a no-op).

```ts
export interface CompactionSection {
  readonly id: string;
  /** Dominant content of this turn's body. */
  readonly kind: "assistant" | "tool_result" | "tool_call";
  /** Serialized size of the section. */
  readonly bytes: number;
  /** Short preview, capped by the core (~200 chars). */
  readonly preview: string;
}

export interface CompactionHookContext {
  /** The droppable sections, in transcript order. */
  readonly sections: readonly CompactionSection[];
  /** Token estimate of the covered span, when known. */
  readonly approxTokens?: number;
}

export interface CompactionHookResult {
  /** Ids of sections to exclude from the summarized transcript. */
  readonly drop: readonly string[];
}

export type CompactionHook = (ctx: CompactionHookContext) => CompactionHookResult | void | Promise<CompactionHookResult | void>;
```

Key decisions, each with its rationale:

1. **A hook over a section list, not a summarizer wrapper.** Letting an extension replace
   `CompactionOptions.summarizer` would be easier to wire but hands it the whole job: the
   core could no longer guarantee that protected material survives, because the extension
   builds the input itself. A hook that answers "drop these ids" keeps the core in control
   of what is rendered, and keeps the safety rules enforceable rather than advisory.

2. **A section is one user turn's body; the user's own message is not in the list at all.**
   The covered span splits per user turn. Each turn contributes at most two things: its
   **user message** (never listed — see §3) and its **body** (the assistant work and tool
   traffic that followed). Only bodies are offered. This matches "one section per turn" and
   happens to make the protection structural: the extension cannot name what it cannot see.
   Per-event sections were rejected (a long session would present hundreds of entries and a
   per-entry judgment, blowing both latency and cost for a marginal gain).

3. **Protection is enforced by absence, then by validation — twice.**
   - **Absence**: user messages and chrome events (`model_switched`, `skill_invoked`,
     `mpm_query`, `session_resumed`, `permission_*`, …) are **never placed in the list**.
     They are the conversation's spine: what the user asked and what moh decided.
   - **Validation**: an id the hook returns that was not offered is ignored, and the
     attempt is recorded as `extension_failed { reason: "unknown_section" }`. Nothing
     happens silently, and a buggy extension cannot invent a section to drop.
   Chrome sections are excluded rather than offered because they are already dense and
   small — summarizer input saved would be negligible, while the cost of losing a decision
   trail is not.

4. **The core keeps a floor on what may be dropped: at least 60 % of the droppable text
   survives.** If the requested drops would cut more than that, the core reduces them —
   dropping the *smallest* sections first, so the wanted large cuts are the ones preserved
   — until the floor holds, and records `keptByFloor: true` on the compaction record. The
   floor makes a catastrophic judgment (drop everything) a bounded event rather than an
   empty conversation; it is a property of the core, not a rule the extension is asked to
   respect.

5. **Fail-open, silently, always.** A hook that throws or does not answer within the hook
   timeout contributes **no drops**: compaction proceeds exactly as it does today, with one
   visible `extension_failed`. The cut is an optimization; its absence changes the size of
   a summary and nothing else. Never a failed compaction, never a blocked turn (compaction
   is already fire-and-forget).

6. **The hook sees previews, never whole bodies for judging.** Each section carries an id,
   a kind, a byte count and a short preview; the model judging relevance does not need the
   full text (and the whole point is that this text is expendable). Consequence: an
   extension's judgment is about *shape* ("a large tool result from a settled turn"),
   which is exactly the signal the cut guide was specified to use.

7. **Scope: compaction only.** The hook is consulted on the auto path and the forced path
   (`moh compact`) alike — both go through the same runner — and never anywhere else. It
   cannot see, alter, or veto anything outside the summarized span, and it has no effect on
   the live conversation, on memory, or on the event log (nothing is deleted from the log:
   the cut changes only the text handed to the summarizer).

8. **Observation and restriction only — never a grant.** The hook can only remove material
   from a summary input. It cannot add, rewrite, reorder or extend; it cannot touch the
   summarizer's output; it cannot touch permissions. The veto-only principle holds.

9. **`tailTurns` is untouched and outranks the hook.** The verbatim tail (`tailTurns`,
   default 10) is outside the covered span by construction, so no drop can reach it: recent
   turns are never summarized, and therefore never cut. This is stated so the interaction is
   deliberate rather than incidental.

## Consequences

- `packages/extension/src/index.ts`: the section/context/result/hook types, the
  `onCompaction` registration, apiVersion `1.4`.
- `packages/core/src/extensions.ts`: dispatch, hook-error collection, shared timeout policy.
- `packages/core/src/compaction.ts`: a segmentation step that derives the section list from
  the covered span (one body per user turn, user messages and chrome excluded), the dispatch
  before `compactionTranscript` renders, the floor applied to the returned ids, and the
  resulting cut reflected in the rendered transcript. `compactionTranscript` grows an
  optional excluded-ids parameter (or an internal variant keeps its current signature
  intact for other callers).
- **No `@moh/core` export changes** (ADR-0004 untouched): the hook type lives in
  `@moh/extension`, the runner is internal.
- Docs: `docs/extending/extensions.md` (the hook, the section vocabulary, the guarantee that
  user messages and chrome can never be cut) and `docs/manual/memory-and-compaction.md`
  (that compaction may now drop settled work, and that user messages and decisions never
  are). Both ship with the implementation PR.
- Rejected: a summarizer wrapper (the core would lose the ability to guarantee protection);
  per-event sections (cost and latency for marginal benefit); letting the extension see
  protected sections with a `protected` flag (a flag is a promise the extension's code could
  ignore, absence is not); no floor (one bad judgment could empty the droppable context);
  fail-closed (an extension could stall compaction); rewriting the summarizer's output
  (nothing about that is an extension's business).
