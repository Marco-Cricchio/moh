# ADR-0033: `beforeTurn` hook — per-turn model ref and pre-send confirmation

Status: accepted · Date: 2026-09-18 · Parent: wayfinder map #799, ticket #815
Consumers: Jev model routing (#787), Jev anti-injection (#791)

## Context

Two Jev use cases need to act **at the start of a user turn**, and today's contract
cannot express either.

**Routing.** `AgentLoop.#runInner` reads the provider at the top of the turn
(`packages/core/src/session/agent-loop.ts:211`), before the `user_message` event is
appended and long before `dispatchBeforeModelCall` fires (inside the model-call loop). The
`beforeModelCall` hook therefore fires too late to choose the provider (it is already
fixed) and too often (once per model call, not once per user turn). `onEvent` on
`user_message` fires after the provider read. `AgentSession.switchModel` is documented to
take effect **from the next turn**. So no existing seam can route a prompt to the model
that serves it: without a new one, per-turn routing is unimplementable.

**Anti-injection.** The guardrail's pre-send confirmation (#791) must be able to ask the
user *before* the message becomes a turn. Nothing fires between "the user pressed enter"
and "the turn exists".

Both needs share one shape: a hook that runs **once per user turn, before the turn
begins**, able to say "use this model" or "ask the user first". Adding them as one seam
avoids two contract additions where one suffices, and both outcomes are
restriction-shaped: a model ref the session may refuse, and a confirmation the user may
answer with "no".

## Decision

**Go.** One new optional hook, `beforeTurn`, registered through the setup context beside
the existing hooks, apiVersion bumping to **`1.2`** (additive — an older runtime ignores
the new hook, which is a no-op).

```ts
export interface BeforeTurnContext {
  /** The user's message as typed (pre-mention-expansion). */
  readonly text: string;
  /** 1-based count of user turns in this session, including this one. */
  readonly turnIndex: number;
  /** The model ref currently serving the session. */
  readonly model: string;
}

export interface BeforeTurnResult {
  /** Model ref to serve this turn (resolved like `/model`). */
  readonly model?: string;
  /** Ask the user to confirm before this turn is sent. */
  readonly confirm?: { readonly reason: string };
}

export type BeforeTurnHook = (
  ctx: BeforeTurnContext,
) => BeforeTurnResult | void | Promise<BeforeTurnResult | void>;
```

Key decisions, each with its rationale:

1. **Fires once per user turn, before the provider is read — and therefore before
   anything is logged.** The hook call precedes the `user_message` event and the mention
   assembly. Consequences: a `model` returned here serves **this** turn (the routing
   point); a cancellation (§4) leaves no trace of a turn that never happened. The log
   order within a turn becomes `model_switched` (if any) → `user_message`, which reads
   correctly: the model changed, then the message started the turn.

2. **Scope: user sends only.** Not on the follow-up model calls a turn makes after tools
   (the per-turn provider is fixed by design, #166), and not on the quality-gate's
   synthetic correction turns (#789) — those are flagged and skipped. A steering send is a
   new user message and therefore fires the hook; each interrupt is a fresh decision point.

3. **`model` resolves exactly like `/model`**: through the session's frozen registry and
   merged endpoint profiles. A resolved ref **does** append the existing `model_switched`
   chrome; a ref equal to the active model is a silent no-op (no event). An
   **unresolvable ref is ignored** — one visible `extension_failed { reason: "invalid_model" }`
   and the turn proceeds on the active model. Never a turn error: an extension with a
   config bug must not take the session down, and never a silent fallback to some other
   model (ADR-0005's spirit).

4. **`confirm`: the user decides, and a cancellation is not a turn.** On `confirm`, the
   client asks (TUI: a modal with "send anyway" / "cancel") and the result is:

   | Outcome | What happens |
   |---|---|
   | accepted | the turn proceeds normally — the model choice, if any, applies |
   | cancelled (TUI) | **nothing** is logged about a user message; the text returns to the composer; the extension's own refusal record (`extension_event`) is the only trace |
   | headless | the turn is refused with one stderr line, the process exits with its normal code, and the same `extension_event` records it |

   Silence-by-default: with no client able to ask (`onPermissionRequest`-less headless),
   `confirm` degrades to refusal, never to a silent send. This matches the existing
   headless ask semantics of the permission gate.

5. **First extension wins**, in registration order, for both fields independently: the
   first hook returning `model` sets it, the first returning `confirm` sets it. Two
   extensions returning a model would otherwise fight unpredictably. Consistent with the
   veto's first-wins rule.

6. **`model` and `confirm` are evaluated together, in one call.** An extension that
   decides both (a router that also flags an injection) returns both; the client's
   confirmation, if cancelled, discards the model change with it — nothing switched for a
   turn that never ran.

7. **The hook cannot grant anything.** No outcome opens a permission, widens a tool's
   scope, or bypasses the permission gate: `model` selects among models the session can
   already reach (the ref resolution is the same one `/model` uses, including its
   authorization path), and `confirm` only ever *asks*. The veto-only principle is
   unchanged.

8. **A hook error or timeout never breaks the turn.** A throwing hook yields one
   `extension_failed { reason: "hook" }` and the turn proceeds on the active model with no
   confirmation — the same fail-open discipline the Jev client already follows.

## Consequences

- `packages/extension/src/index.ts`: `BeforeTurnContext`/`BeforeTurnResult`/`BeforeTurnHook`,
  the `beforeTurn` registration in `ExtensionSetupContext`, apiVersion `1.2`.
- `packages/core/src/extensions.ts`: a `beforeTurn` hook set plus a dispatch that returns
  `{ model?, confirm?, errors }`.
- `packages/core/src/session/agent-loop.ts`: the dispatch lands at the top of `#runInner`,
  before the provider read; a returned ref goes through the same resolution `switchModel`
  uses (the resolution helper is shared, not duplicated); cancelled/refused turns return
  before the `user_message` append.
- `packages/core/src/session/session.ts`: the steering path keeps its own semantics (a new
  user send), and the quality-gate's synthetic correction turns are marked so the hook
  skips them.
- Clients: the TUI renders the confirmation modal (its copy is a use-case concern, #791);
  the CLI headless path refuses with a stderr line.
- Docs: `docs/extending/extensions.md` (the hook, its scope, its outcomes) and
  `docs/manual/jev.md` (what a confirmation means to a user) ship with the implementation
  PRs, not with this record.
- Rejected: reusing `beforeModelCall` (fires too late — the provider is already read — and
  once per model call, which would flip models mid-turn); a `user_message`-triggered
  `onEvent` (same lateness); making `switchModel` retroactive (the per-turn provider
  guarantee of #166 exists so a turn is served coherently); a hard `block` outcome
  (the user, not an extension, decides whether to send; a confirm modal already gives the
  extension a veto-equivalent when the risk is real); separate hooks for model and confirm
  (one turn-start decision point, one registration).

## Amendment — 2026-09-18, #791 (the `confirm` outcome, implemented)

The use case that needed the confirmation (anti-injection) had to be implemented, and §4
presupposed a channel the decision left unnamed: the extension is the one that records the
outcome ("the extension's own refusal record is the only trace"), but a cancelled turn
leaves no `user_message`, so there was nothing in the log for it to observe. Four details
are fixed here; the rest of the decision stands.

1. **apiVersion `1.4`** (not the `1.2` this record assigned: `1.3` was consumed by
   ADR-0038's control channel, and the two additions below travel with the `onToolResult`
   of ADR-0034 in one PR).

2. **The client seam is `SessionConfig.onConfirmTurn`** (with its `ConfirmTurnRequest`
   re-exported from `@moh/core`, as the config surface requires — ADR-0004): the client
   answers `"send" | "cancel" | "refuse"`. `send` proceeds; `cancel` means the turn never
   happens; `refuse` is what a client that cannot ask answers, and **what the core answers
   when no seam is present** — silence-by-default is implemented, not implied. The loop
   returns `{ status: "cancelled" }` for both, before anything is logged, and the model a
   hook named in the same call is discarded with the turn.

3. **`confirm.onResolved(outcome)`** — an optional callback riding the hook's result. The
   core calls it exactly once, after the client answered (or immediately with `refuse`), so
   the asking extension can record what became of the turn. It is the only way §4's "the
   extension's own refusal record" can be written; a throwing callback is swallowed, like
   every other extension-side observability path.

4. **The headless exit code is unchanged.** `moh run` refuses the turn with one stderr line
   and exits 0: a refusal is not a crash, and it is not the 130 of a cancelled run (which
   the client's own flag distinguishes). The TUI's cancel additionally returns the message
   to the composer — the client's own affordance, since the core holds no draft.
