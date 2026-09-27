# ADR-0049: The provider's own declared window outranks the map

Status: accepted · Date: 2026-09-27 · Issue: #986 · Related: #1032 (amendment, the second door), #949, #948, #946, #947, #974, ADR-0022, ADR-0045, ADR-0046

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

### The second door: the provider speaks without being refused

A refusal is not the only way a provider declares a window. moh already fetches each
provider's own model listing (`fetchLiveCatalogs`, ADR-0045) — some listing contracts carry
the window itself, and one of them reads it today: `parseCodexModels` takes the ChatGPT/Codex
backend's `context_window`. Measured on a real cache (2026-09-26), that endpoint declares
**272,000** for every model it lists, while the shipped catalog rows for the same models claim
**1,050,000** — a factor of 3.9, in the dangerous direction. The listing does not correct it:
`mergeLiveCatalog`/`mergePickCatalog` are additive, so a row that collides on id keeps the
shipped value and only *new* ids are appended. moh even ships `272000` in those very rows as
the price tier threshold (`cost.tiers[].inputTokensAbove`) and computes the window as if the
number did not exist.

The same lookup is also **blind to the endpoint**: `contextWindowFor(model, endpointType)`
resolves through `catalogEntryFor(type, id)` with no base URL, so it can only see a provider
*kind* while the catalog is organized per endpoint file. On the `opencode` kind with the Go
base URL, the lookup resolves the **Zen** catalog, misses a row `opencode-go.json` ships, and
returns **0 (unknown)** — abstaining where moh holds the answer, or silently taking one
product's window for the other (the two are separate products by decision, #920).

The owner's requirement, stated as the product outcome: **moh uses the context window the
provider itself reports for the endpoint in use.**

## Decision

**A context window a provider declares for the endpoint in use is the one moh uses, and it
outranks the catalog and the 180k fallback.** It is the *declared window*, and a provider
declares it through two doors.

### Door one: the refusal (issue #986)

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
single endpoint-keyed resolution every consumer funnels through (**the endpoint's declared
window** (a refusal learned this session, or this endpoint's own listing) → the shipped row
for that endpoint → 0 = unknown). No consumer keeps a private override, and no second lookup
path is introduced.

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

### Door two: the endpoint's own listing (issue #1032)

**The window the endpoint itself reports, for the endpoint in use, is what moh uses.** The
listing moh already fetches (ADR-0045) carries it for the contracts whose parser reads a
window; the shipped catalog row is the fallback for when the provider has not spoken.

- **Adherence is not left to release time.** The shipped number for the Codex rows is derived
  from aggregators, and the provider's own listing cannot become a pipeline source: it needs a
  subscriber's credential, which CI does not have. So the runtime reads the endpoint's own
  cached listing, and the shipped row is hand-authored to match (the ADR-0046 sidecar, with
  author, date and reason), giving every machine — offline, freshly installed, headless — the
  provider's number even before it ever speaks.
- **`fresh`, `cached` and `stale` all count.** The provider's last word stands until a newer
  one replaces it: the age of the entry is shown wherever the number is shown (ADR-0045's
  `stale` already carries the age), and an error direction is self-healing — if the provider
  lowered its limit and moh's cached number is too large, the refusal teaches the truth
  (door one). Only `failed` and `unsupported` — nothing to serve — fall back to the catalog.
- **The lookup is keyed by the endpoint, not the provider kind.** A window belongs to the
  endpoint that serves the model (Zen is not Go; an `openai-compat` endpoint with a known base
  URL has its catalog), and keying it by kind is what made two endpoints read the wrong file —
  or none. Feeding an endpoint's listing into the resolution requires the endpoint identity, so
  this is a prerequisite, not a parallel change.
- **The reservation is untouched.** ADR-0046's shrink hatch (`acceptContextShrink` accepts a
  smaller number, never an absence) is the pipeline-side guard that keeps a corrected window
  from becoming a silent zero.

## Consequences

- The catalog's `contextWindow` is no longer the last word for a model that has declared one
  in this session. A reader comparing a log's numbers against the shipped catalog will see
  them disagree — that is the point, and the `declared_window` event names both.
- A window can now be right for one client and wrong for another: a machine with a valid
  cache uses the provider's number, one without falls back to the shipped row. That is a
  freshness difference, not a truth difference — the shipped row is corrected to the same
  source — and it shrinks as the pipeline's authored numbers are kept true.
- The relationship with ADR-0046 is tidy by construction: the catalog stays the *declared
  fallback*, corrected where the provider has spoken; nothing writes a catalog at runtime.
- A logged session re-opened later (or on another machine) may compute a different window:
  windows are runtime facts, not log facts — as they already were, since catalogs change
  between releases. What the log holds is what was *decided* with them (markers, skipped
  cuts, refusals).
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
- **(Door two) Fix the shipped numbers at release time and leave the runtime alone**: the
  Codex listing needs a subscriber credential, so the pipeline cannot read it at all; the
  shipped value would be a hand-typed number that rots until someone notices. It is kept as
  the *fallback*, not as the live answer.
- **(Door two) Treat an expired cache entry as no declaration**: an expired listing is still
  the provider's last word, and both error directions are covered — a lowered limit is caught
  by the refusal that follows (door one), and discarding it would hand the arithmetic back to
  a number the provider contradicts.
- **(Door two) Resolve the window by provider kind, as today**: two endpoints of one kind read
  each other's catalogs (Zen for Go), and an `openai-compat` endpoint whose base URL maps to a
  shipped catalog never sees it. A window belongs to the endpoint.
