# ADR-0036: `setPromptNote` — per-turn prompt contribution

Status: accepted · Date: 2026-09-18 · Ticket #819
Consumers: Jev prompt classification (#788), Jev skill suggestion (#793)

## Context

An extension can talk to the model only through `appendToPrompt(note)`, which pushes into a
per-instance list the session reads at each prompt assembly
(`packages/core/src/session/session.ts`'s assembly step reads `#extensions.notes()`). That
list **accumulates and has no clear or replace operation**: a note written once stays in
every later prompt, and a note rewritten each turn would be present once per turn
thereafter.

Two Jev use cases need prompt content that is **about the current turn only**:

- **#788** adds a task-type hint (a bugfix turn should reproduce before fixing; an analysis
  turn should not edit files), which changes as the task type changes.
- **#793** adds at most one line naming a skill that fits this request, which by
  construction differs almost every turn.

The existing pre-model-call hook is not the answer either: it receives a read-only prompt
(sections, system, messages) and returns `void`, and it fires once per *model call* (several
times within one turn) rather than once per turn.

So neither seam can express per-turn content, and the accumulation semantics make the
existing one actively wrong for it.

## Decision

**Go.** One new method on the setup context, apiVersion bumping to **`1.5`** (additive — an
older runtime ignores it, a no-op for the extension).

```ts
export interface ExtensionSetupContext {
  // ...existing
  /** Set this extension's note for the current turn; `null` removes it. */
  setPromptNote(text: string | null): void;
}
```

Key decisions, each with its rationale:

1. **One note per extension, replacing.** The method sets *this* extension's note; a second
   call replaces the first, `null` removes it. One writer, one slot — a note cannot leak
   into later turns by accident, which is the failure mode `appendToPrompt` has today.

2. **The note is ephemeral and auto-cleared at the start of every turn.** Unlike
   `appendToPrompt`'s notes (durable, written at setup, part of the extension's identity in
   the prompt), a turn note describes *this* turn. Auto-clearing means a stale hint cannot
   survive into a context it was never about: an extension that wants a note every turn
   writes it every turn, and an extension that stops writing simply stops being represented.
   This mirrors the `setStatus` discipline of ADR-0032 (ephemeral, state-of-now).

3. **A dedicated prompt section, after the project's instructions.** Turn notes render in
   their own section (`turn_notes`) distinct from the existing durable extension notes, so a
   reader of the prompt can tell what is permanent from what is about this turn. It is placed
   **after** the system prompt and the project instruction documents and **before** the
   conversation context: a hint is a suggestion subordinate to the project's own rules, never
   a way for an extension to weaken them.

4. **Several extensions: one slot each, rendered in registration order.** Two extensions
   producing a note produce two lines, both attributed by section position (one note per
   extension, no merging). No extension can overwrite another's note: the API is per-instance
   by construction.

5. **The note is text, not structure.** No section naming, no ordering control, no ability to
   remove or reorder the durable notes. A single line of guidance is what both consumers
   need; a structural prompt-editing surface would be a far larger contract for far less
   used surface. `setPromptNote` also cannot touch the system prompt, the project
   instructions, or the conversation.

6. **Observation and suggestion only — never a permission.** Nothing here grants, denies or
   bypasses anything: the note reaches the model, and the model may ignore it. The veto-only
   principle is untouched, and the permission gate does not consult this seam.

7. **A note is capped and never model-visible across a boundary.** The core truncates an
   oversized note with a marker (a prompt contribution is not an unbounded channel), and a
   note set during a turn is not retroactively injected into already-sent calls.

## Consequences

- `packages/extension/src/index.ts`: `setPromptNote` on the setup context, apiVersion `1.5`.
- `packages/core/src/extensions.ts`: a per-instance turn-note slot (distinct from `notes`),
  cleared on turn start, exposed to the assembly.
- The session's prompt assembly: a new `turn_notes` section fed from the live instances,
  positioned per §3. The composer's section list grows one entry.
- `appendToPrompt` keeps its current meaning (durable, setup-time) and its behaviour is
  unchanged — this ADR adds a second, narrower door rather than changing the first.
- Docs: the extension-writing chapter gains both doors and the difference between them
  (durable identity note vs per-turn hint); the implementation PR carries it.
- Rejected: a returnable addition on the pre-model-call hook (fires per model call, not per
  turn, and would let a hint multiply within one turn's calls); a dedicated section-returning
  hook (a structural prompt surface for a one-line need); reusing `appendToPrompt` with a
  clear convention (accumulation is the bug, not the API names); placing turn notes before
  the project instructions (an extension must not outrank the project's own rules).

The consumers ship in their own issues: the task-type hint (#788) and the skill hint (#793).
