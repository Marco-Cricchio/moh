# ADR-0056: Hook timeouts, and a "required check" that belongs to the extension

Status: accepted · Date: 2026-09-28 · Issue: #999 · Parent: wayfinder map #996
Amends: the map's "Mandatory checks" decision (#996, revised by this ADR) · Related: ADR-0031 (restrict-only), ADR-0037 (`requestTurn`), ADR-0053 (capability slots)

## Context

The map recorded: *"A configured required check failing, being unavailable, or not answering
prevents the protected operation; accessory components may fail without halting work."* That
sentence puts the enforcement in the runtime. The owner's decision in #999 puts it in the
extension instead: a required check is the extension's own gate, and when the extension does
not answer, work proceeds. The two cannot coexist, and the map's sentence is the one that
changes.

The second half of the decision needs a fact the code does not have. Only the compaction hook
runs under a deadline today (`hookTimeoutMs = 5_000`, `extensions.ts:1308-1390`, #979). Every
other hook of the turn — `beforeTurn`, `beforeModelCall`, `onToolCall`, `onToolResult`,
`afterTurn` — is awaited without a ceiling (`#each`, `extensions.ts:1494-1506`), so a hung
extension stalls the turn forever. That makes *"does not answer"* undecidable: nothing can
distinguish an extension that is thinking from one that is gone, and no policy about
non-answers can be enforced. It matters in practice, because the shipped first-party extension
calls a network endpoint from these hooks (Jev's guardrail, anti-injection and quality gate),
where a hang is a normal failure mode and not a pathological one.

## Decision

**Every turn-path hook invocation runs under a wall-clock ceiling**, generous and
configurable, default 30 s (bash's own default). The compaction hook keeps its shorter 5 s
window: the compaction path has its own deadline and ADR-0035's cut guide is a hint, not work.

**An expired or thrown hook contributes nothing.** The turn proceeds as if that hook had
answered with no opinion: no veto, no ask, no note, no replacement. One visible record says so
(a log line and a footer/stderr state), and the hook is not retried within the turn. A hook
that exceeded its window is *absent*, not authoritative — including on the paths where its
answer would have been a restriction.

**A required check is the extension's own gate.** No runtime concept is introduced. An extension
that must protect something refuses it through the doors it already has — `veto` (a hard stop,
ADR-0031), `ask` (a question to the human), and the capped cycles of ADR-0037 (Jev's quality
gate stops itself after two correction rounds). The extension that declares a check is the
extension that enforces it; the runtime neither holds nor runs a check of its own.

**Non-answer is not a block.** A check whose extension is disabled, un-consented, crashed or
expired does not prevent the protected operation: work proceeds, with one visible mark. This is
the fail-open reading of the map's sentence, and it is deliberate — a runtime that could be
stalled or vetoed by a silent third party would hand an extension the power to stop moh's work,
which is the one thing the absolute prohibitions exist to prevent.

**The doors that do stop work are unchanged and are not extension-owned:** the user's own
permission rules, the per-occurrence questions (an out-of-root write asks every time and never
becomes a rule), the client's consent seams, and `maxIterations`. An extension can only restrict
a call it sees; it can never make moh refuse a call it does not.

## Consequences

- The map's *Mandatory checks* decision is rewritten to read: a required check is the
  extension's own gate; its failure or non-answer is visible and never halts work; accessory
  components may fail without halting work (unchanged).
- The 30 s default is a policy a slow-but-legitimate hook must fit; an extension that needs more
  sets its own ceiling in configuration, and the setting is visible next to the others.
- "Unavailable" becomes decidable and reportable: today `extension_failed { reason: "hook" }`
  covers a throw, and the expiry path needs its own visible reason.
- The `#each` await chain still serializes hooks in registration order; with a ceiling per
  invocation, N hooks can add up to N × 30 s to a turn, which is why the ceiling is configurable
  and not a global budget. A global per-turn budget is explicitly not introduced here.
- Nothing in this decision restricts the model's own tools, the user's rules, or a client's
  consent: it only bounds how long moh waits for a third party.

## Considered Options

- **Leaving the turn-path hooks without a deadline** — rejected: it makes "does not answer"
  undecidable and lets a hung extension freeze a turn, which is a bug users would report as
  moh hanging.
- **A short 5 s ceiling everywhere** — rejected: it breaks the first-party extension, which
  performs network round-trips inside these hooks; a ceiling that reliably breaks Jev is not a
  safety feature.
- **Treating an expiry as a veto (fail-closed)** — rejected: it would let any extension stop any
  tool call by not answering, granting by silence what ADR-0031 withholds by design.
- **A runtime-held required check, as the map first said** — rejected by the owner: it is a new
  gate concept, a second consent surface, and an authority a package would hold over moh's own
  operations. The extension that cares does the checking.
- **Disabling an extension for the rest of the session on its first timeout** — rejected: a
  timeout is an event, not a verdict; it would silently remove a guardrail's other powers, which
  is exactly the kind of invisible state change this design avoids.
