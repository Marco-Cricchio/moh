# ADR-0038: client→extension control — the `extension_control` event

Status: accepted · Date: 2026-09-18 · Parent: wayfinder map #799 (feature #787)

## Context

An extension can observe the loop, restrict a tool call and publish a status. It can
also keep session state (the Jev router's streak, its manual-override flag, the
guardrail's verdict cache). What it cannot do is be **commanded**: there is no path from
a client action to a running extension instance.

That gap is why #787's `/routing off` and `/model auto` were cut from the routing PR and
deferred. The owner ratified their behaviour, and every ratified option runs into the
same wall: a session command lives in the client
(`packages/tui/src/commands.ts`), while the router lives inside an extension instance
created by session assembly. Writing the config instead was rejected — a session command
that silently persists a permanent setting is a different feature (that is what the
Settings toggle is for), and it cannot express "release the manual override", which is
by definition session state.

## Decision

**Go.** One additive log variant and one session API. The core learns that a client may
address a running extension; it never learns what any payload means.

```ts
// @moh/core
export type ExtensionControlPayload = Record<string, unknown>;
// AgentSession
setExtensionState(extension: string, payload: ExtensionControlPayload): void;
```

The session appends:

```ts
| { type: "extension_control"; extension: string; payload: ExtensionControlPayload }
```

Delivery: the runtime dispatches the event to the **named extension only** — every other
extension's `onEvent` hooks do not see it (see rationale 2). The extension receives it
through the hook it already has:

```ts
ctx.onEvent(({ event }) => {
  if (event.type !== "extension_control") return;   // not mine
  if (cmd === "off") state.paused = true;
});
```

Key decisions, each with its rationale:

1. **The control channel carries state, not actions.** The payload is a plain
   JSON-serializable object (`{ cmd: "off" }`, `{ cmd: "auto" }`), not a function call
   into the extension. This keeps the core generic, makes the intent **replayable** (a
   resumed log still explains why the extension was in the state it was in), and leaves
   the extension free to interpret it — the alternative (a direct method call into a
   runtime extension) would be a second, unlogged back channel that replay could not
   reconstruct.

2. **Delivery is targeted.** An untargeted fan-out would be a bug generator: the Jev
   guardrail listens on `onEvent` for `session_mode`, and a `{ cmd: "off" }` broadcast
   would reach it too. The core filters by the stamped `extension` name, using the name
   the client addresses — which is the extension's own `name` (the `extension_loaded`
   event already publishes it).

3. **An unknown extension is not an error.** `setExtensionState("no-such-ext", …)`
   appends the event (the log records what the client asked for) and delivers it to
   nobody. The client that owns the command checks the presence first and reports a
   meaningless command honestly; the core never throws for it.

4. **The event is chrome.** It is never fed to the model, never a turn error, and never
   mutates session state by itself: the extension decides what it means. The transcript
   renders it as one dim line (extension `extensionEventLine`), so a user reading a
   session sees when and why routing was paused.

5. **Not a permission channel.** `setExtensionState` can only make an extension *more*
   restrictive (pause, release an override) — it cannot grant a tool call, widen a scope
   or write a rule. The veto-only principle is untouched: this is the client talking to
   an observer, not a permission verdict.

6. **apiVersion `1.3`.** Older runtimes ignore the new event type (their `onEvent` still
   fires; the handler simply never matches), which is fail-open and matches the
   additive-only policy. Extensions that use the channel must tolerate never receiving a
   command.

## Consequences

- `packages/core/src/types.ts`: the `extension_control` variant of `AgentEvent`.
- `packages/core/src/extensions.ts`: `dispatchEvent` filters by target and delivers a
  control event only to the addressed instance (a new targeted dispatch entry).
- `packages/core/src/session/session.ts`: `setExtensionState(extension, payload)`
  appends through the normal append path (sink, listeners, single-writer guard intact).
- Clients: `packages/tui/src/commands.ts` gains `/routing on|off|auto`, `/model auto`
  (reserved word) and the state report. Headless clients have no session commands, but
  the embedded-library case keeps working through the same API.
- Docs: `docs/extending/extensions.md` (the channel, its targeting, its limits) and
  `docs/manual/jev.md` (what the routing commands do).
- Rejected: writing `typesafe.routing` from a session command (persistent by accident,
  cannot express "release the override"); a direct in-process method call into an
  extension (unlogged, unreplayable, and it would make the core's dispatch surface
  extension-shaped); broadcasting control events to every extension (one extension's
  command becomes another's, silently).
