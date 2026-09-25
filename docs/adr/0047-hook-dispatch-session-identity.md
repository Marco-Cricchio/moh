# ADR-0047 — A hook dispatch belongs to one session: identity in the context, and events in that session's log

Date: 2026-09-25 · Status: accepted · Refs: ticket #944
Amends: ADR-0033 (the `beforeTurn` context gains `session`), ADR-0032 (an
`appendEvent` is attributed to the dispatching session, not to the runtime)

## Context

An extension registers its hooks **once per runtime**, and the setup context
hands it one durable state bag (`ctx.state`) and one event channel
(`ctx.appendEvent`). A subagent child owns no runtime: it borrows its
parent's (`toolHooks`, #784 spec §5) so that the turn-start decision point
(`beforeTurn`) and the tool seams run for the child too.

Both halves of that sharing are per-*runtime* while their meaning is
per-*session*, and #944 is the bill arriving:

- **State.** The routing judge created its whole state (streak,
  `decidedModel`, `mismatchAnnounced`, `override`, `paused`) inside the
  runtime's `state.routing`, so the parent and every child shared it. Two
  children spawned in one parent turn supplied the two consecutive turns the
  hysteresis waits for: the router switched inside a child on the strength of
  turns that were never the parent's, wrote the switch into the parent's
  expectation, and the parent then reported a `mismatch` it had invented —
  after which routing was dead for the rest of the session
  (`mismatchAnnounced` stuck true, coherence never returning on its own).
- **Events.** `ctx.appendEvent` reached the runtime's single channel, which
  only the owning session listens on: a child's `jev_judgment` lands in the
  parent's log and renders in the parent's transcript. The user read
  `jev · routing · switch to X` in a session whose model never moved.

The spec says the opposite of what the code did
(`docs/spec/jev-routing.md` §6: the streak "lives **in memory, per
session**"), and §9 ratifies sharing only "the same client, pool, thresholds
and cache" — never the state.

The identity needed to fix either half did not exist in the contract:
`beforeTurn`'s context carried nothing that distinguishes two sessions
(`turnIndex` 1 and the same serving model look identical in a parent and in
the child it just spawned), so an extension could not key per-session state
even if it wanted to.

## Decision

**A hook dispatch runs on behalf of exactly one session, and says which.**

### 1. `beforeTurn`'s context names the session (apiVersion 1.8, additive)

```ts
readonly session?: { readonly id: string; readonly owner: boolean };
```

Opaque and stable for the lifetime of the session instance; `owner` is true
for the session that registered these hooks, false for a borrower — a
subagent child. The field is **optional** in the contract and absent on a
runtime older than 1.8, which reads as "one session": the pre-#944 behavior,
fail-open like every other additive field (1.4's `onResolved`, 1.7's
`endpointCooldowns`).

The rule for extension authors is stated where they will read it (the field
doc and `docs/extending/extensions.md`): **key per-session state by
`session.id`**. The itemization of every context (a `session` on
`onEvent`, `onToolCall`, `afterTurn`, `afterModelCall`, `sessionStart`…) is
deliberately *not* in this ADR — the identity is added where a use case needs
it, and a later additive bump can extend it without breaking anyone.

### 2. An extension event is attributed to the session that dispatched the hook

The core scopes the dispatches of a session that borrows a runtime
(`AgentSession` wraps the borrowed `beforeTurn`, tool-gate and tool-result
dispatches in `ExtensionRuntime.withSession`, an async-context store), and
`appendEvent` resolves against that scope: the child's chrome is appended to
**the child's** log and appears in the child's transcript. The owner's own
dispatches keep the runtime's single channel — that is what preserves
load-order chrome and its held-events ordering at startup.

Two consequences, both deliberate:

- The hook-failure bucket follows the same scope, so two children
  mid-dispatch cannot drain each other's `extension_failed`.
- An async-context store rather than one mutable "current session" field:
  a parent turn runs its children concurrently, so the dispatch's session
  must survive every `await` inside it.

### 3. The guardrail's own sharing is left alone

The guardrail deliberately judges a child's bash calls through the parent's
gate (#784 spec §5) and its verdict cache is keyed by command + git state,
not by session. Nothing in #944 changes that; the event-attribution half
applies to it for free (its chrome now lands where the call happened).

## Consequences

- Jev's router keeps its state per session: the owner session's state stays
  in the durable store (a hot-reload keeps its streak and override), a
  borrowed session gets its own in-memory bucket, bounded (drop-all past 64
  live children — the same bound the guardrail's cache uses).
- A child is born with **the pause in force** in the owner session
  (`/routing off` is the user's statement about the work at hand, and it
  covers the subagents that work spawns) and with no inherited manual
  override (that is the user's own pick in their own session). A command
  typed by the user is owner-scoped by construction: it arrives through the
  `onEvent` dispatch of the session that owns the runtime.
- A child's judgment lines no longer appear in the parent's transcript. This
  is user-visible and therefore rides the manual
  (`docs/manual/jev.md`: subagents are routed, their lines and their switch
  live in their own session).
- `MOH_EXTENSION_API_VERSION` is `1.8`. An extension that ignores the field
  keeps working exactly as before.
- Known limits, left to their own tickets:
  - The per-turn `extension_event` volume cap (#846) stays runtime-level: a
    child's events count against the current turn's budget. Conservative
    (drops are visible), not a leak.
  - A borrowed session's dispatch must be scoped by the core. A *future*
    borrowed seam that forgets `withSession` degrades to today's behavior
    (the owner's channel), never to a wrong log.
  - `setStatus` stays runtime-level: a status is a claim about the
    extension, and it is the owner's footer that shows it.
