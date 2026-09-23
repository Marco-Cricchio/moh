# ADR-0045: Live model-catalog refresh reports status; client noise is contextual

Status: accepted · Date: 2026-09-23 · Related: #920, #551, ADR-0004, ADR-0029

## Context

The live model-catalog augmentation (#551) deliberately degrades in silence.
Every failure — an offline laptop, an expired subscription token, a provider
listing that answers with an empty array because of a version gate, a provider
with no verified listing route at all — produces the same observable result:
`fetchLiveCatalogs` returns fewer entries, the picker shows the vendored
catalog, and nothing anywhere says the refresh did not happen.

The #920 audit showed what that costs. A user's Z.ai endpoint had been showing
seven models for months; the provider's listing exposed eleven. The fetch had
never been wired for that provider, and no surface in moh could distinguish
"you are up to date" from "we never asked". The same audit found the ChatGPT
listing returning an empty list under a client version that hides models, and
OpenCode rows that routed nowhere. All three were invisible from the client's
chair, and all three were found by probing providers by hand rather than by
reading anything moh recorded.

Two distinct things were conflated by the original contract:

- **the models** — what the picker shows, where a vendored catalog plus a cache
  is a perfectly good answer and offline must not become an error; and
- **the freshness fact** — whether this endpoint's list was just refreshed,
  served from a cache of a known age, or could not be refreshed at all.

The client needs the second in order to say anything honest, and a library
embedder needs it in order to build its own presentation. Today neither can
have it: the seam's return shape carries only the first.

## Decision

**`fetchLiveCatalogs` retires the bare `{ endpoint: models[] }` projection and
returns one explicit status per endpoint. Clients decide how loud that is, and
the rule is contextual: an explicit user gesture always answers, an automatic
background refresh interrupts only when it leaves the user without a list.**

The status vocabulary is per endpoint, and the model list is a projection of it:

- `fresh` — this run reached the provider (new cache entry written);
- `cached` — served from a cache entry within its TTL; no network call made,
  which is the normal, healthy steady state, not a degradation;
- `stale` — the refresh failed and an expired cache entry was served instead,
  **carrying the age of that entry**;
- `failed` — the refresh failed and there was nothing to serve, with the
  reason kept for the caller (offline, unauthorized, empty listing);
- `unsupported` — this provider kind has no verified listing contract (Baseten
  today), so the vendored catalog *is* the answer and its absence is not a
  failure.

Client presentation follows from that vocabulary:

- The `/model` picker's `r` is an explicit request, so it always reports its
  outcome — which endpoints advanced, which stayed on a cache and how old it
  is, which could not be refreshed.
- Startup and picker-open stay non-invasive: a refresh that leaves a usable
  list behind (vendored catalog, fresh or stale cache) shows nothing, and one
  that leaves the user with no list at all says so once. A provider without a
  listing contract never produces a notice: static is its design, not a fault.
- Settings' model picker shows the same status it is already rendering models
  from, so "no model" and "no data" stop looking identical.

The status stays a **picker/cache seam** (ADR-0004 amended below). Routing,
`catalogEntryFor`, pricing and thinking resolution keep reading the vendored
data, untouched by whether a listing call succeeded.

## Consequences

- The conflation that hid #920's findings is gone: freshness is recorded where
  it is produced, and any client can surface it without re-deriving it from an
  entry count.
- Offline behaviour is unchanged in substance — a cached or vendored list is
  still served — but it is now *named* rather than implied.
- The exported shape changes: this is the ADR-0004 door being reopened, which
  is the reason this decision needs recording at all. Every consumer of
  `fetchLiveCatalogs` (`@moh/tui` model picker, Settings panel) must move to
  the status projection in the same change.
- A `failed` reason is carried for callers, not rendered verbatim: it exists so
  a client can explain a refresh failure without re-implementing the contract
  logic, and so a future diagnostic surface (CLI, log line) has something to
  print.
- No config key is added. `liveModels.enabled: false` still means "never
  fetch"; the separate question of *how much notice* is a client policy, not a
  user setting, until usage shows otherwise.
- Cost of being wrong: a status vocabulary is small and additive, so a provider
  that later gains a contract only changes one row from `unsupported` to
  whatever its fetches produce.

## Alternatives considered

- **Keep the silent contract, add a log line.** Cheap, and it would have caught
  the audit's findings in a terminal that happens to be watched. Rejected as
  the whole answer: the failure has to reach a human through the surface they
  are already looking at, and the `r` refresh is exactly that surface. Debug
  logs are for developers, not for a user who will never open one.
- **Warn on every failed refresh.** Honest, and it makes the failure rate
  visible immediately. Rejected because it punishes the normal case: launching
  moh on a plane, or with a lapsed subscription token, produces a banner on a
  screen where a usable model list is already on show. Noise on the healthy
  path is how real warnings get trained away.
- **Always refresh before showing the picker.** Removes the cache question by
  refusing to have one. Rejected: it puts a network round trip (per endpoint,
  up to a 10s timeout each) in front of opening a modal that currently renders
  from memory, and it degrades the offline experience that the cache exists to
  provide.
- **A dedicated diagnostics command instead of client surfaces.** Useful in
  itself, and it is where the `failed` reason will eventually be printed.
  Rejected as the only answer for the same reason as the log line: it requires
  the user to suspect a problem before they can discover it — the exact trap
  #920 documented. Recorded as a possible follow-up, not a substitute.
- **Treat an empty listing as a valid empty catalog.** Keeps "zero models" and
  "no data" formally distinct at the seam. Rejected: a provider that answers
  `200 {"data": []}` is not advertising an empty catalog, and a version gate or
  an unauthorized account both present that way, so the unsafe reading wins by
  default. This is already settled in the #920 implementation (empty is a
  failure), and the status vocabulary is what makes it reportable.

## Amendment — ADR-0004, live-catalog status seam

**Re-opened door**: `fetchLiveCatalogs`'s return contract and the types it
carries (`core/src/live-model-catalog.ts`), consumed by `@moh/tui` (the
`/model` picker's `r` refresh and the Settings model picker). The reopen is the
point of this ADR: the previous projection could not express freshness, so
clients could not report it. The status is per endpoint and derived inside the
defining module — the fetchers, cache read/write, TTL handling, the contract
table and the merge stay internal, and core tests keep importing them directly.
This seam remains fail-soft: it never throws for a provider failure, never
mutates the auth store, and never blocks the picker.
