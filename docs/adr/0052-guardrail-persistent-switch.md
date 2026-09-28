# ADR-0052: the guardrail gets a persistent switch

Status: accepted · Date: 2026-09-28 · Issue: #1041 · Amends: ADR-0038 (`The guardrail is the exception by design`)

## Context

ADR-0038 (with #784) made the guardrail the one Jev use case with **no config
opt-in**: a stored API key *is* the switch. Everything followed from that:
the guardrail was armed in every session the extension ran in, `moh jev
guardrail on|off` was refused as *session-only* rather than answered as a
typo, the Settings entry `Jev (TypeSafe)` had no row for it, and the one way
to disarm it was `/jev` — session-warm, gone at the next start. The
`jev_usecase` line carried an explicit note ("the guardrail has no persistent
switch") instead of the ordinary asymmetry every other use case states.

The rationale was symmetrical with activation: the key buys a service, and
the guardrail is what the service *is*; a flag that could turn it off would
mean a user paying for an unfiltered account. In practice the rule has three
costs that the rest of the product does not share:

1. **Asymmetry of doors.** Every other use case has both a persistent switch
   (Settings, `moh jev <use-case> on|off`) and a session switch (`/jev`).
   The guardrail has only the second, and the surfaces have to say so in
   three places (the CLI's usage text, the CLI's refusal line, the transcript
   note). A vocabulary with one exception is a vocabulary clients must
   special-case.
2. **No way to start disarmed.** A user who wants a session with no bash
   judgments — a scripted run, a yak-shave in a scratch tree, a workflow
   whose commands trip the classifier — can only turn the guardrail off
   *after* the first false positive, inside an open session, every time.
3. **A loaded word.** "A stored key *is* the switch" reads, in the Settings
   entry, as *the key turns Jev on* — but the entry's other rows are all
   opt-ins, so the one row that cannot be changed is the one the user looks
   for first.

ADR-0041 already moved this line once in a related direction: it stopped
refusing `guardrail off` in `yolo`, on the ground that a filter which cannot
be disarmed in the mode that needs it most is not a filter but a trap. The
same argument applies one level up, to the session: a filter that can only be
disarmed after it has already bitten.

## Decision

**Go — the bash guardrail gets the same two doors as every other use case: a
persistent flag (`typesafe.guardrail`, Settings row + `moh jev guardrail
on|off`) and the session-warm `/jev` flip it already had.**

### 1. The flag is an opt-*out*, because the key arms the guardrail

`typesafe.guardrail` is `boolean`, default **true**: absent means armed, and
`false` is the only value that disarms. It is written as an explicit value
(never deleted on the way back on), exactly like `classification` — the two
are the pack's opt-outs and the panel should say what the file says. The
ratified reading of #784 is preserved in substance: *a stored key arms the
guardrail*; what changes is that the arming is now a value the user can see
and change, not a fact of activation.

With the flag `false` the extension registers everything else the caller
asked for and judges no `bash` call at all — the state reads `off` with the
note `off in the config`, **never `inert`**: the use case is available, the
user turned it off.

### 2. Both doors, and the ordinary asymmetry

- **Settings** (`Jev (TypeSafe)` → `Guardrail`) and **`moh jev guardrail
  on|off`** write the flag; it is read at session assembly, like every other
  use-case flag. `moh jev` accepts all seven names now — the *session-only*
  refusal is deleted, not kept as a special case.
- **`/jev`** keeps flipping it for the open session, in `yolo` too
  (ADR-0041 is untouched: this ADR adds a door, it takes none away), and a
  warm `on` starts judging in a session whose config disarmed it — the
  availability/config split of ADR-0038, applied to the last use case that
  was exempt from it.
- The `jev_usecase` line loses its bespoke note and states what every other
  use case states: *"off for this session — the config still says on"*. The
  core, the modal and the transcript need no special case for the guardrail
  anywhere.

### 3. One shared account of what each use case does

Reading the vocabulary from clients exposed the gap the ADR-0038 exception
left in the panel: nine rows of switches with no statement of what any of
them does. The descriptions now live once, next to the names they describe
(`JEV_USE_CASE_DESCRIPTIONS` in `@moh/jev-guard`), and both surfaces render
them for the row under the cursor — the Settings sub-menu after ` - `, the
`/jev` modal as a line under the selected use case. A description states what
a use case *does*; the live status stays each surface's own field, and the
two are never merged into one string. (The three Settings rows that are not
use cases — API key, Status, Remove — describe themselves in the panel; they
have no counterpart in `/jev`.)

## Consequences

- The product no longer has a use case whose door is a one-way trip: every
  name in `JEV_USE_CASE_NAMES` is writable, and every use case has both a
  persistent and a session switch.
- **The guardrail can be off in `yolo` at assembly time**, and that is
  deliberate. ADR-0031's posture ("a filter that can be disarmed in the mode
  that needs it most is not a filter") already lost that argument to
  ADR-0041; the honest statement of the remaining protection is that `off`
  is always a decision the user made, visible in the modal, in `moh jev
  status` and in the file — never a state a mode can silently produce.
- One more flag in the `typesafe` block, reported by `moh jev status` and
  `--json` (key order: `active`, `keyHint`, `timeoutMs`, `guardrail`,
  `routing`, `injection`, `lint`, `classification`, `rerank`, `skills`).
- ADR-0038's *"no use-case vocabulary in the core"* and *"no persistence from
  a session command"* stand unchanged: the flag is written by the Settings
  panel and the CLI, and `/jev` still writes nothing.

## Superseded points

- ADR-0038, section *"Availability and config are two different bits"*: the
  sentence *"The guardrail is the exception by design: it has no config
  opt-in (a stored key *is* the switch, #784), so its warm state is
  session-only and its line says that instead of inventing a config
  contrast"* is superseded. The guardrail has a config opt-in now (on by
  default), its warm state carries the ordinary asymmetry, and the
  `jev_usecase` note it used to emit is deleted. The rest of that section —
  availability as a separate bit, refusals for unavailable use cases — is
  unchanged and is exactly what the guardrail now uses too.
- ADR-0038's `guardrail off` refusal in `yolo` was already superseded by
  ADR-0041; this ADR removes the last trace of the exception (the CLI's
  session-only refusal and the transcript note).
