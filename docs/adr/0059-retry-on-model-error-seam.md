# ADR-0059: The retry-on-model-error seam

Status: accepted · Date: 2026-10-01 · Issue: #1109 · Related: ADR-0033 (beforeTurn), ADR-0031 (restrict-only), ADR-0049 (declared windows), ADR-0050 (selected/serving), #948 (context-fit guard)

## Context

Today a provider call that fails with an error the Route does not already
handle kills the turn. The Route's own taxonomy covers the transient
kinds — `quota_exhausted`, `rate_limited`, `network`, `overloaded` move
down the fallback chain — but the semantic kinds end the turn outright: a
privacy-settings refusal, a content filter, an invalid model ref, a
context-fit refusal. Often the session has another endpoint configured
that would have served the call fine; only the human, watching the error,
can perform that recovery by hand.

Extensions already own two model decision points: `beforeTurn` (ADR-0033)
chooses the model of a turn before it is sent, and the #948 fit guard
polices every switch. What is missing is a mid-call decision point: *this
model failed with this error, may I try another?*

## Decision

A new extension hook, `onModelError` (apiVersion 1.10), is the
retry-on-error decision point.

**When it fires.** Once per failed provider call whose normalized
`ProviderError` kind is **not** Route-handled — anything outside
`quota_exhausted`, `rate_limited`, `network`, `overloaded`, and never
`aborted`. The ordering of intervention is unchanged for errors the Route
already handles: those keep the current Route behavior (fallback chain,
recovery probes), and the seam never sees them.

**The hook shape.** The hook receives the facts of the failure — the
serving ref that failed (`model`), the normalized kind (`errorKind`), the
sanitized message, and the #944 session identity — and may return
`{ model: "<endpoint>/<model-id>" }`: an alternative ref to retry the
failed call on. First hook to answer wins, in registration order; a
throwing hook is fail-open (one `extension_failed` record, no retry).
The hook can only propose.

**Validation is the switch's own.** A proposed ref is applied through
`AgentSession.switchModel` — the same registry resolution and the same
#948 context-fit guard as the manual `/model` switch. A fit refusal
records exactly one `switch_refused` chrome event and no retry happens on
that ref; an unresolvable ref records `extension_failed { reason:
"invalid_model" }`. A successful application records the session's
`model_switched` chrome, as any switch does.

**The retry is mid-turn.** #166 reads the provider once per turn because a
mid-session switch would otherwise yank the model out from under a
streaming call. The retry seam is the one deliberate exception: the failed
call produced no serving turn, so re-reading the provider after the switch
cannot interrupt anything — it *recovers* something. The retry continues
the same logical call (#1099): same `callId`, next attempt ordinal, after
the failed attempt's `model_call` record.

**Bound.** One turn gets at most `MAX_MODEL_ERROR_RETRIES` (3)
consultations. A proposed ref that fails the same way spends budget; an
exhausted budget ends the turn exactly as a consultation without an
answer. This keeps a misbehaving extension from turning one error into an
unbounded loop of paid calls.

**Silence is the past.** With no routing extension active, no hook
answering, or a refused proposal, the turn ends with the original error —
byte-identical to the pre-seam behavior. The failed `model_call` is
recorded first, so the log reads in the order it happened either way.

## Consequences

- Restrict-only precedent (ADR-0031) extends to recovery: an extension
  proposes, the core validates. Nothing in the seam can grant a
  permission, invent a model, or bypass the fit guard.
- ADR-0049's door one still teaches: a context-length refusal that gets
  retried elsewhere still declares its window to the session before the
  retry leaves.
- ADR-0050's selected/serving pair absorbs the switch naturally: the
  selected reference moves with the switch, and the retry is the serving
  model from the next attempt on.
- The consultation budget is turn-scoped (reset per `#run`), matching the
  loop's other per-turn guards (#190, ADR-0037).
