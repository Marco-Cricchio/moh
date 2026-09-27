# ADR-0049: The provider's own declared window outranks the map

Status: accepted · Date: 2026-09-27 · Issue: #986 · Related: #949, #948, #946, #947, #974, ADR-0022, ADR-0046

## Context

Every context number in moh comes from one lookup: `contextWindowFor(model, endpointType)`,
a hit on the moh-owned catalog (ADR-0046). When the catalog has no row, the number is **0
= unknown**, and each consumer decides for itself what to do with an unknown window:

| Consumer | Arithmetic | Unknown window (0) |
| --- | --- | --- |
| Compaction producer, auto trigger | measured input > `window × 0.8` | arms on an absolute 180k instead |
| Compaction tail policy (#949, ADR-0022 §2) | cut ceiling `window − 8k`, tail cap `window × 0.25` | keeps the bare turn-count preference |
| Switch guard `contextFitFor` (#948) | measured ≤ `window − 8k` | abstains — never blocks |
| Fallback chain eligibility (#948) | same predicate on each stop | abstains — the stop stays eligible |

A provider that refuses an overflowing request states its **own** window in the refusal. In
the #949 session, on an endpoint whose catalog row claims 1,000,000
(`opencode-go` / `deepseek-v4.1-flash`):

```
This endpoint's maximum context length is 131072 tokens.
However, you requested about 234666 tokens ...
```

moh already reads that text — `classifyStatus` matches
`/context (length|window)|too many tokens|maximum.*tokens/i` to *classify* the failure — and
then throws the number away: `ProviderError` is `{ kind, message }` and nothing else. So the
ceiling the producer computed, the switch the guard refused, and the stop the chain kept or
skipped were all dimensioned on 1,000,000 while the endpoint served 131,072.

**A wrong window is worse than an unknown one.** An unknown window abstains — the guard
proceeds, the tail policy keeps its preference, and the provider's refusal remains the hard
wall that then arms compaction (#947). A wrong window is *trusted*: it silences every
abstention and makes the arithmetic confidently wrong. The one number nobody enforces was
the one number governing the arithmetic.

`context-fit.ts` cited "the core `context_length` ticket" for the broader unknown-window
policy. No such ticket exists in the tracker. This ADR closes that dangling reference: the
policy for a window that was never declared by anyone *is* what the table above describes
(abstain / 180k), and this ADR adds the case where the provider **did** declare one.

## Decision

**A context window a provider declares in its own overflow refusal is learned for that model
for the session's lifetime, and outranks both the catalog and the 180k fallback.** It is the
*declared window*.

### Recognition is conservative, and happens before the truncation

Only a refusal that states a window in a formula moh knows is learned. Recognition happens
where the number still exists: today every path hands the classifier at most 300 characters
of the provider's message (`boundedDescription`, and `describeKnownField(..., true)` for the
body), so a verbose body can lose the number before anything reads it. Recognition therefore
runs on the untruncated refusal text, ahead of the truncation that feeds the rest.

Two numbers sit in those messages — what was requested and what the limit is — and the same
message carries request ids, timestamps and prices. A window marker must be attributable to
its number for the formula to match. Each shipped formula is pinned by a test carrying the
**real** provider wording; a formula nobody has seen a real refusal for stays unshipped.

### Only a real refusal teaches

The number is adopted when the provider *actually refused*. A declared number is by
definition one the provider accepts — it just said so by rejecting a larger request — so the
correction applies in **both directions**: when the catalog over-claimed (1,000,000 declared
against 131,072 refused) *and* when it under-claimed (8,000 against 131,072 refused). The
under-claim is not the safe side: moh would fold a conversation the provider serves happily,
and refuse switches into models that fit. "A wrong number is worse than an unknown one" is a
statement about over-claiming, and it is the over-claim we remove.

Absent a refusal there is no learning path: no probing, no inference from model names or
prices, no guessing at "probably smaller".

### Scope: the model that declared it, for the session

The declared window is keyed by the **model reference that was refused**. Two different
models on one endpoint do not inherit each other's number — a refusal names the subject it
refused ("this endpoint's maximum context length…", "this model's maximum context
length…"), and a model that has declared nothing keeps using the catalog exactly as today.
An endpoint whose *service-wide* limit is lower than a model's row then teaches that limit to
each model that hits it, one refusal at a time, and never over-generalizes to a model that
was never refused.

The scope is the **session**, not the installation:

- The learned value **outranks the 180k fallback** — the fallback exists only for a window
  nobody knows, and after a refusal moh knows one.
- The **8k reserve is untouched** by this: it is headroom for the next turn and the reply, a
  property of the fit decision, not a window.
- It **carries across a resume** — the refusal is in the log, so reopening a closed session
  re-derives the same number, with no new store and no replay divergence.
- It **does not outlive the session**, and it never edits the catalog: the catalog stays the
  versioned, declared source (ADR-0046) and correcting a shipped row remains its own
  release-time pipeline concern. The declared window is a runtime fact of one session.

### One value, one owner

The producer and the fit guard must never be able to disagree — that is exactly the
divergence #948 closed. The declared window is therefore **one value with one owner**: the
single window resolution every consumer already funnels through (catalog hit → declared
window → 0 = unknown). No consumer keeps a private override, and no second lookup path is
introduced.

### Persisted in the log, visible once

Learning appends one `declared_window` chrome event carrying the model, the declared window
and the catalog value it replaced (0 when the catalog knew nothing). It is appended **only
when the declared number differs from the effective window moh would have used** — the log
records corrections, not confirmations. Chrome only: it never reaches provider context.

The event is the notice and the persistence in one: the TUI renders it as one visible
transcript line at the moment it happens, a headless client prints one line of the same
message (the extension-consent precedent), and a later resume shows it where it always
was, in its place in the log. It is **never repeated for the same number**: the correction
is a fact that lands once, and a re-refusal that declares the same value teaches nothing
new. A *different* value is a new fact and gets its own event and its own line.

### Two numbers, wherever a window is displayed

Correcting the arithmetic while the pickers keep showing the catalog value would leave the
interface contradicting the tool — the exact confusion this ADR removes. Wherever a model's
window is shown for a ref that declared one, moh shows **both**: the declared value and the
catalog value side by side (the model picker's rows, the `/model` text list, the active-model
indicator). A model that declared nothing displays exactly as today.

### An unrecognized refusal leaves a trace

A refusal that matches no known formula teaches nothing, and the gap would otherwise be
invisible: the session log already carries the message (truncated), so what is missing is a
place where unrecognized refusals *accumulate* — across providers and across sessions —
which is how a new formula gets discovered and shipped.

moh therefore appends one line per unrecognized refusal to a bounded diagnostic file in the
user's own moh directory (the dotdir every other moh-owned artifact lives in), carrying the
date, the endpoint type, the model, a cleaned excerpt of the refusal and a repeat count.
Identical messages are never written twice — repeats increment the count instead — and the
file is capped, so it stays small. It carries nothing of the conversation beyond the text the
provider itself put in its refusal.

## Consequences

- The catalog's `contextWindow` is no longer the last word for a model that has declared one
  in this session. A reader comparing a log's numbers against the shipped catalog will see
  them disagree — that is the point, and the `declared_window` event names both.
- The fit guard, the fallback eligibility rule and the compaction arithmetic stay one
  decision each; they only gain one more input to the single lookup they already share.
- A switch keeps a switch's semantics: the declared window of the *serving* model does not
  follow the session into another model's arithmetic.
- A refusal whose formula moh does not recognize keeps today's behaviour exactly (abstain /
  180k, the refusal arms compaction per #947) and leaves its trace for the formula to be
  added later.

## Alternatives rejected

- **Keep the learned number in memory only** (a live window, gone on restart): the log is the
  session (Principle 2). A resume would silently fall back to the wrong number and reproduce
  the failure the ADR exists to remove — the session would have two truths depending on how
  it was opened.
- **Correct only downwards** (adopt a declared window only when it is smaller than the
  catalog's): an under-claiming catalog would keep folding healthy conversations and refusing
  switches that fit. The declared number is not a guess — it is a number the provider
  demonstrably accepts.
- **Store it per endpoint instead of per model**: the subject of a refusal is a model, and
  inheritance would give a window to a model that never declared one.
- **Learn the number from anything that looks like a limit**: a wrong learned number is worse
  than an unknown one, and the failure is silent. Guessing trades a visible gap for an
  invisible lie.
- **Leave no trace of unrecognized refusals** (only the truncated message in the session log):
  the formulas cannot then grow — the corpus that would justify the next one is never
  collected.
- **Wait for the live catalog listing (#551, ADR-0045) to fix the number**: that path *adds*
  models the shipped file does not carry; it never corrects a shipped row's window, and it is
  a client-side refresh rather than a statement about what this endpoint served. The authority
  on what the provider accepts is the provider refusing.
