# ADR-0037: `requestTurn` — a core-mediated synthetic turn

Status: accepted · Date: 2026-09-18 · Ticket #820
Consumer: Jev end-of-task quality gate (#789)

## Context

The quality gate (#789) judges the change at the end of a task and, on a finding, must let
the model fix its work: append a user-side message naming the failure and run a turn. An
extension today has **no door** to do that — it cannot reach the session, cannot send a
message, cannot run a turn. Its only writes are a log record, a footer status, a prompt
note, and hook return values; none of them starts a turn.

Leaving the extension to fake it is not acceptable either: writing a `user_message` into the
log directly would produce a conversation record that never actually ran, and the session's
turn machinery (queue, streaming, usage accounting, compaction spans) would not know about
it.

At the same time this is the one place where an extension could drive the session forward,
so the door has to be narrow and the loop protection must not depend on the extension's good
behaviour — the same principle as the compaction floor (ADR-0035) and the guardrail's
fail-open: **a core property, not a promise**.

## Decision

**Go.** One new method on the setup context, apiVersion bumping to **`1.6`** (additive — an
older runtime ignores it, a no-op for the extension).

```ts
export interface ExtensionSetupContext {
  // ...existing
  /**
   * Ask the core to run one turn with a synthetic user-side message.
   * Resolves when the turn settles; `false` when the core refused it
   * (depth limit reached, session not accepting turns).
   */
  requestTurn(text: string): Promise<boolean>;
}
```

Key decisions, each with its rationale:

1. **The core mediates; the extension supplies only text.** The extension asks for a turn and
   the core runs it through the normal path (queue, provider call, streaming, tools, usage,
   settlement). The extension never touches the event log, the message list or the provider,
   and cannot request a turn on a disposed or closed session.

2. **It is a normal turn, marked synthetic in the log.** The message lands as a
   `user_message` carrying a `synthetic: true` marker. Everything else about the turn is
   ordinary — the same loop, streaming, tools, usage rollup, `done` event. The marker is what
   lets replay, the transcript renderer and any future analysis tell a turn a human typed
   from one the machine triggered: a reader must never be shown a message the user did not
   write without knowing why it is there.

3. **The core enforces the depth limit: at most 2 consecutive synthetic turns.** A
   `requestTurn` beyond the limit is refused (`false`) and recorded as a visible
   `extension_failed`-style event, so the refusal is auditable rather than silent. The
   counter resets when a real user turn begins. Any extension — buggy, over-eager, or fed a
   judgment that always finds a finding — can therefore cost at most two extra turns before
   the core stops it. This mirrors the guardrail's cycle cap and the compaction floor: the
   bound belongs to the core.

4. **A synthetic turn does not fire `beforeTurn`.** The hook is defined for the user's own
   sends (ADR-0033): routing a machine-generated correction message through the router, and
   re-running the anti-injection check on text the guardrail itself composed, would add cost
   and a risk of chains (a correction that routes, that gets flagged, that triggers another
   correction) for no benefit. The marker from §2 is how downstream logic knows. Consequences
   to keep in mind: a synthetic turn serves whatever model is active, and the correction text
   is never content-checked.

5. **The call is asynchronous and settles with the turn.** `requestTurn` resolves when the
   turn it asked for settles — so a gate can request a correction, re-judge, and request a
   second one, in order, without polling. A refusal resolves `false` immediately.

6. **Headless behaves identically.** The door is session-level, not client-level: `moh run`
   gets the same correction behaviour as the TUI. Nothing here requires a UI, and nothing
   blocks on one.

7. **Compaction and history treat it as a normal turn.** It appears in the session history,
   counts for the verbatim tail and for compaction spans, and is included in turn counts —
   because it *is* a turn that happened and its work must be summarizable like any other. The
   synthetic marker makes it identifiable; it does not make it invisible.

8. **Restriction-shaped, not a grant.** The door cannot alter an existing turn, cannot
   re-run a completed one, cannot bypass the permission gate or a tool's own permissions (the
   synthetic turn's tool calls are gated exactly like any other), and cannot inject into the
   model's context outside the message text. It adds work for the agent; it never widens what
   the agent may do.

## Consequences

- `packages/extension/src/index.ts`: `requestTurn` on the setup context, apiVersion `1.6`.
- `packages/core/src/extensions.ts`: the dispatch-side plumbing that lets a hook reach the
  session's turn entry point, plus the consecutive-synthetic-turn counter.
- `packages/core/src/session/session.ts`: the turn-request entry, the counter reset on a real
  user turn, and refusal semantics on a closed session.
- The event types: `user_message` gains the optional `synthetic` marker; the transcript
  renderer distinguishes it; replay rebuilds it identically (the marker rides the event).
- The turn lifecycle: a synthetic turn skips the `beforeTurn` dispatch (ADR-0033's scope
  clause is amended accordingly).
- Docs: the extension-writing chapter documents the door, its limit and its marker; the
  manual explains, in the quality-gate section, that a "correction turn" is machine-triggered
  and bounded. Both with the implementation PRs.
- Rejected: letting the extension write a `user_message` into the log itself (a conversation
  record that never ran); a full turn-orchestration service for extensions (the consumer needs
  one bounded follow-up, not a scheduler); trusting the extension to cap its own loops (a bug
  becomes an infinite turn chain); firing `beforeTurn` on synthetic turns (re-routing and
  re-checking machine-composed text, with chain risk); making the synthetic turn invisible in
  history (a reader could not tell what happened).

The consumer ships in its own issue: the end-of-task quality gate (#789).
