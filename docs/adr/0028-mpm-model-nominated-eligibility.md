# ADR-0028: MPM orientation eligibility may be model-nominated via a read-only query tool

Status: accepted · Date: 2026-09-13 · Extends: #616 (ADR-0013 spec), ADR-0026

## Context

MPM's automatic orientation plan (#616) reaches the model only when the
task text names a mapped path. Non-developer users ("vibe coders") never
type paths — they describe intent ("fix the login feature") — so for
them MPM silently does nothing and the model falls back to grep/read/glob
exploration. The engine exists; most users have no natural way to
benefit from it.

#616's principle says eligibility is "conservative and purely local — no
pre-call LLM classifier". The owner clarified the intent: the ban is on
the LLM **building or interpreting the map**. Nothing forbids the model
from **nominating candidates** — interpreting natural language is what
models already do implicitly. The structural truth (what exists, what is
fresh, what relates to what) must remain the core's, verifiable, and
deterministic.

## Decision

1. **A read-only core tool, `mpm_query`, lets the model nominate seeds.**
   Input is a single seed: an exact mapped path, a unique path suffix, or
   a symbol name. Output is the same trusted format as the #616 plan —
   path, coordinate, relation, reason — every entry re-hashed fresh and
   locally proven. A hallucinated candidate is discarded deterministically,
   exactly like an unmapped textual token today.
2. **Validation remains local and deterministic.** The model changes only
   *who* proposes seeds (the model instead of text sniffing); the core
   remains the sole authority on what enters a result. No LLM ever
   extracts, ranks, or vouches for an entry.
3. **The result is persisted in full** in the event log's `tool_result`:
   replay fidelity beats compactness (resume/fork see exactly what the
   model saw). Compact chrome-only results were considered and rejected.
4. **Subagents get the tool, never the service.** The tool executes in
   the parent's tool runner; the child holds only the tool description.
   #620's rule is unchanged: the `MpmService`, lifecycle, and mutation
   surfaces never reach a child.
5. **Diagnostics gain a `model-seeded` fallback reason**: the automatic
   plan produced nothing, but a model-nominated query succeeded — a
   distinct orientation style, metadata only.
6. **The automatic plan (#616) is unchanged.** `mpm_query` is additive:
   tasks that already name mapped paths keep their free plan; the tool
   covers the rest.

## Consequences

- The "purely local" wording of #616 is refined, not violated: the LLM
  translates human intent into a candidate indication; the core verifies
  everything structurally. Recorded here so the deviation from the
  literal wording is traceable.
- The tool result lands in the event log (bounded: 8 entries / 1500
  chars, same budgets as the plan) — an accepted, explicit exception to
  "MPM never touches the event log": what enters the log is a tool
  result the model consumed, not map state or diagnostics chrome.
- No new permission surface: the tool is read-only over projection
  metadata and defaults to "allow" like `read`/`grep`.
