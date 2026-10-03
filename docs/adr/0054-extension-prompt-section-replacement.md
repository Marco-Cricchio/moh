# ADR-0054: An extension replaces a prompt section, and the core writes the record

Status: accepted · Date: 2026-09-28 · Issue: #999 · Parent: wayfinder map #996
Related: ADR-0011 (turn-scoped skill prompt), ADR-0031 (restrict-only), ADR-0032 (observation seams), ADR-0036 (per-turn note), ADR-0047 (borrowed runtime), ADR-0053 (capability slots)

## Context

The map (#996) fixed the prompt's shape: the core owns final composition, an extension may
modify authorized parts *including replacing them*, the original text stays recoverable, and
every change is inspectable and disengageable. No door does any of it today.
`appendToPrompt` writes into a trailing `extension_notes` section — and `notes()`
(`extensions.ts:430`) flattens every instance's notes into one array, so the attribution is
lost before the text reaches the composer. `setPromptNote` is one 300-character hint per turn
(ADR-0036). The only replacement in the codebase is the first-party turn-scoped skill prompt
(ADR-0011). `beforeModelCall` is observation-only: it receives the composed sections and
returns `void`.

The prompt is reassembled at every model call — `PromptComposer`, nine sections in
`SECTION_ORDER`, called from `AgentSession.#assemblePrompt()` — and never frozen. A
replacement is therefore a projection of live state, not a stored artifact: nothing has to be
invalidated or revoked, because nothing was kept. What the log knows about the prompt is one
`session_start.promptVersion`, the hash of the *initial* composition: it says nothing about
what was in force later, let alone who changed it.

## Decision

**Replaceable parts.** Six data sections — `environment`, `tools`, `skills`, `memory`,
`session_state`, `mpm` — plus the extension's own contribution (`extension_notes` /
`turn_notes`). `base` and the project's instruction files (AGENTS.md, CONTEXT.md, a
`prompts/system.md` override) are not replaceable: they are moh's identity and the user's own
words. Hiding a section is a replacement with empty text, recorded as `hidden`, never a silent
omission. The default for a section added to `SECTION_ORDER` later is *not replaceable*.

**Who may, and how it is asked.** The extension declares in its own code which sections it may
touch (a capability scope, ADR-0053); the enable-consent question names them, and an update
that widens the set re-asks. A replacement for a section outside the declared-and-granted set
is refused at runtime, visibly, and the core's text stands for that call.

**How it arrives.** As the *return value* of `beforeModelCall`:
`sections?: Partial<Record<SectionName, string | null>>`, `null` meaning hidden. The hook is
read-only today, so the function keeps its identity and gains a value; no persisted
replacement API exists, hence no state to revoke and no "who removed it?" to answer.

**It follows the runtime into the children.** A subagent child borrows its parent's runtime
as `toolHooks` (`session.ts:272`, ADR-0047) and today receives only the tool half of it —
`ToolHookChecker`, `dispatchBeforeTurn`, `checkToolResultHooks` (`session/config.ts:168`).
That surface gains `beforeModelCall`: a section replacement is in force in every session whose
prompt the borrowed runtime composes, and its chrome lands in that session's log (#944). The
guardrail already judges a child's tool calls through the parent's gate; this states the same
rule for the prompt, and it is a deliberate widening of the borrowed surface rather than a
description of what happens today. The child's own composer overrides
(`subagents.ts:344`, the turn-scoped MPM orientation and the preset role text) are applied by
the core before any extension sees the sections and keep their place.

**One author per section.** In one composition a section has at most one author: a second
extension returning a replacement for an already-replaced section is refused with a visible
reason, and the first author's text stands. The turn-scoped skill prompt keeps its precedence
over `skills` (ADR-0011). Hook dispatch stays in registration order, and two replacements are
never promised adjacent in the assembled prompt — only the order of *sections* is fixed.

**Provenance, written by the core.** A replaced section carries one line at its head,
composed by the core, naming the author and its version
(`[extension: figma-context v0.3 — section replaced]`), so the model can tell which text is
not moh's voice. The core also keeps the text it composed itself, for the fallback below and
for the client's comparison view.

**Failure.** A replacement runs inside a short wall-clock window (5 s). Expired or thrown, the
affected sections fall back to the core's text for that call, the turn proceeds, and one
visible record says so (log line + footer/stderr state). A replacement is never retried within
the turn.

**The record.** When the set of contributions in force changes within a composition — a
section replaced or hidden, its author, its version — the runtime appends one
`prompt_override` chrome event **at the end of the turn's event run**. The log stays
append-only and ordered by turn, and replay reconstructs what was in force. The event records
*who* and *which part*, not the words: extension text never enters the log verbatim (the inlet
rule of #997), and a replaced `memory` or `session_state` can be tens of kilobytes that moh
will not carry on every change. The text is reproducible from the extension's own code and its
version — the version is in the event, the bytes' hash in `extensions.json`. A section that
returns to core text is itself a change of what is in force, so disengagement is recorded too
(`mode: "restored"`), keeping the reconstruction exact.

**Disengaging.** No hot switch. Revocation rides the ADR-0053 boundary — it takes effect from
the next session, a live session keeps its powers — and `/reload` is the in-session door.
"Disengageable" means the contribution disappears when the extension does, not that a
keystroke strips it mid-turn; an extension may offer its own switch, as Jev's use-case doors
already do.

## Consequences

- `notes()` / `turnNotes()` must start carrying attribution: the per-instance `notes: string[]`
  already exists, and the flattening is what loses the author.
- The borrowed-runtime surface (`config.toolHooks`) widens by one hook, and a child's prompt is
  now composed with contributions from the parent's extensions — a fact the child's own log
  records but the child's caller cannot opt out of.
- `session_start.promptVersion` still describes the initial composition only. This ADR does not
  add a prompt hash to `model_call`: a hash would say "a different prompt served this call" and
  never what changed, while the change event says both.
- The core archives no replaced text. "The original stays intact" is guaranteed by the core
  composing its own version at every assembly, not by the log holding a copy.
- A hook that is slow by nature (Jev calls the network inside `beforeModelCall`) must fit the
  5-second window or be adapted: the window is the price of "did not answer" being a decidable
  outcome (ADR-0056 owns the general hook-timeout rule).
- The client's inspection surface reads the last `prompt_override` plus the live state; there is
  no second store.

## Considered Options

- **Append-only, as today** — rejected: replacing a section (a user's own `session_state`, a
  filtered `memory`) is the point of prompt control, and the map decided it.
- **Replacing `base` too** — rejected: an extension rewriting moh's identity changes every
  behavioural rule at once, and no consent screen can state that consequence honestly.
- **One event per composition** — rejected as noise: that is a log of one repeated fact.
  A change is the information.
- **Recording the replaced text in the event** — rejected: it makes the log a verbatim inlet for
  foreign text, strains the ADR-0032 payload caps, and duplicates what the extension's code
  already is.
- **A persisted `replaceSection(name, fn)` API at setup** — rejected: it introduces state to
  revoke and a question to answer; a per-call return value leaves nothing behind and is
  inspectable by construction.
