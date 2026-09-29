# ADR-0055: Orchestration — a capability that creates and coordinates sessions

Status: accepted · Date: 2026-09-28 · Issue: #999 · Parent: wayfinder map #996
Related: ADR-0031 (restrict-only), ADR-0037 (`requestTurn`), ADR-0047 (borrowed runtime), ADR-0050 (routes), ADR-0053 (`spawn-subagent`, absolute prohibitions)

## Context

The map decided that a user-initiated *workflow* may create working conversations and
coordinate agents without repetitive confirmation, within agreed limits, with visible activity
and the ability to stop; and that each spawned agent receives only the authorizations its task
needs, bounded by the workflow's authorizations and those the owner allowed to transfer, at
runtime. ADR-0053 reserved the power as a capability (`spawn-subagent`), with a cap of ten per
extension per session, declared in the extension's code and granted with the enable consent.

Nothing of it exists. The only creator of child sessions is the built-in `spawn` tool
(`spawn: "ask"` by default), and a child gets a copy of the parent's permissions, a snapshot of
its runtime rules and its live mode, a strict subset of its tools (`#childTools` — no `spawn`,
no `mcp__*`), the parent's extension runtime borrowed as `toolHooks` (ADR-0047), and a route of
its own (ADR-0050). Children never spawn: depth is one, by absence (`subagents: null`). Parent
and child are linked only by `subagent_spawn { callId, name, preset?, log }` /
`subagent_result`, carrying the child's log path — sessions have no identity of their own in
the log, and a client that restarts has no way to say which session created which.

**Vocabulary.** In moh, *workflow* is already a built-in feature (the user config key, tracker
sync, `/workflow`, the frontier overlay, the `agents` presets). The word stays there.
**Orchestration** is what an extension does when it creates and coordinates sessions; the child
conversation remains a **subagent**, as `CONTEXT.md` already has it. "Agent" alone is not moh
vocabulary and does not enter it.

## Decision

**The envelope, granted once and intersected per spawn.** The enable consent grants a ceiling:
how many sessions the extension may create (ADR-0053's ten per extension per session) and which
scopes it may hand to a child (tools, permission mode, path scopes, `maxIterations`). Every
spawn request then names what the task needs, and the runtime applies
`declared ∩ consented`: a request outside the envelope is refused with a visible reason, never
silently narrowed, and the child receives nothing that was not named — capability by absence,
the ADR-0053 mechanism. A child can never widen what its parent holds, and a child's own
request for anything outside the envelope fails the same way.

**Limits.** The number of sessions (envelope ∩ ADR-0053's cap) and each child's
`maxIterations`, which already exists. No spend or wall-clock counter is introduced. The
session's existing concurrency ceiling (three in flight) applies to every spawn, whoever asked.

**Operations.** An orchestration may:

- **read the turn activity of a session it spawned** — the shape the child-tail seam already
  produces (`tailChildLog`, ADR-0047 / #497): messages, tool calls and their outcomes, the
  turn's outcome, status and usage, sanitized and bounded. Its `TAILED_EVENTS` excludes
  provider `reasoning`, and so does this: one rule in the codebase, no second reading of the
  same log.
- **write into a session it spawned** — send a further message to a child it created, without
  returning to the user for each one (that is what the consent replaced).
- **list the project's sessions** — the same metadata the resume picker shows (identifier, age,
  last turn, consumed state), including sessions it did not create.

It may **not** read the content of, or resume, a session it did not spawn: those are
conversations that were never addressed to it. It may not create grandchildren.

**The record, and who asked.** `subagent_spawn` names the requester — the model, or the
extension by name — and the limits applied to that child. From that event a client reconstructs
an orchestration's children, and the stop below, across restarts. Sessions gain no new
identity: `session_start` still carries no id, and the parent link is not re-decided here.

**One stop.** The owner gets one command — *stop everything this orchestration started* —
which lists the live children and aborts them. Children already abort with their parent's turn
(the existing signal plumbing); what is added is a door that does not require turning the
owner's own turn off, and a record that it was used. Stopping does not revoke the extension
(ADR-0053's session-level revocation stays what it is) and does not unload it (ADR-0054).

**The per-call question.** A spawn requested by an orchestration does not re-ask: the question
was asked at enable time and the envelope is its answer, which is what "without repetitive
confirmation" means. A spawn requested by the model keeps `spawn: "ask"`. The prompt names the
requester, so the two are never confusable in the log.

**Prohibitions unchanged.** An extension cannot grant itself a capability, widen the envelope,
alter a permission rule, disable another extension, or mask a log event (ADR-0053). The runtime
performs; the log records.

## Consequences

- A spawned child inherits the part of the runtime the borrowed surface allows — the tool gate,
  `beforeTurn`, the tool-result hooks (`session/config.ts:168`) — which is what makes an
  orchestration's own guardrails apply inside its children; ADR-0054 widens that same surface
  with `beforeModelCall`. `#944`'s session identity keeps each session's chrome in its own log.
- `subagent_spawn` gains a requester field, which is also what makes the list of an
  orchestration's children derivable without session identity — the smaller change, chosen over
  a parent id in `session_start`.
- The headless client cannot ask for consent, so an un-consented orchestration capability stays
  skipped and visible, exactly as ADR-0053/ADR-0046-adjacent consent already behave.
- The orchestration's texts (task prompts, coordination notes) are extension text and follow
  ADR-0054's rule: they reach the model, never the log verbatim.

## Considered Options

- **Envelope as permission rules written per spawn** — rejected: a rule is the user's grammar
  and an extension writing one breaks ADR-0031. The envelope is a scope, not a rule.
- **Children inherit the parent's permissions wholesale, as `spawn` does today** — rejected: it
  is what the map's per-agent authorization decision exists to prevent, and it makes the cap the
  only limit.
- **A parent id in `session_start`** — deferred, not rejected: it is a change to session
  identity (resume, fork, sharing semantics) and a larger decision than this ticket. The
  requester field on the spawn event answers today's need.
- **Handing the orchestration the child's whole log** — rejected: it delivers the provider
  reasoning and every detail of the child's calls, where the tailed activity is already the one
  reading rule the codebase has.
- **Allowing grandchildren** — rejected: depth one is what makes the envelope checkable at every
  level and keeps the "one stop" complete.
