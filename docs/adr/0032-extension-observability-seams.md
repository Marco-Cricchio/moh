# ADR-0032: extension observability seams — `appendEvent` and `setStatus`

Status: accepted · Date: 2026-09-18 · Parent: wayfinder map #799, ticket #813 (feature #784)

## Context

`@moh/extension`'s setup context hands an extension `appendToPrompt(note)` and six hook
registrations. Everything else an extension observes stays inside the extension: it can
influence the loop (hook return values) and speak to the model (a prompt note), but it
cannot **record** anything in the session log and cannot **show** anything to the user.

The Jev guardrail (#786) needs both. Every judgment must land in the event log as a
complete `jev_judgment` record (a ratified decision: full payload, no sampling), and an
outage must be visible without spamming — the ratified `∅ jev offline` chip in the TUI
footer, one stderr line in headless. With today's contract the guardrail's only outlet
would be `appendToPrompt`, which would inject its telemetry into the model's context:
wrong on every axis (model cost, prompt pollution, silent).

The tempting shortcut — teach the core about `jev_judgment` — violates the ratified
boundary "the core never knows about Jev" and would need a core change per future use
case. These two seams instead keep the core generic: it learns that extensions may
record events and publish statuses, not what any of them mean.

## Decision

**Go.** Two additions to `ExtensionSetupContext`, both observation-only, with the
apiVersion bumping to **`1.1`** (additive; an older runtime ignores the new methods,
which is a no-op for the extension).

```ts
export interface ExtensionSetupContext {
  // ...existing
  /** Record a structured event in the session log. Never permissions, never model context. */
  appendEvent(event: { name: string; payload?: unknown }): void;
  /** Publish this extension's footer status; `null` clears it. Ephemeral. */
  setStatus(text: string | null): void;
}
```

The resulting log entry (the runtime stamps the emitter; the extension never names itself):

```ts
| { type: "extension_event"; extension: string; name: string; payload?: unknown }
```

Key decisions, each with its rationale:

1. **The runtime stamps `extension`.** The extension supplies only `name` + `payload`,
   and the runtime fills in the name of the instance that called it. An extension cannot
   impersonate another, and every record in the log is attributable by construction.

2. **Payload validated, drops are visible.** The payload must be JSON-serializable and
   within a **size cap of 8 KiB** (serialized). A non-serializable payload (cycles,
   functions, BigInt) or an oversized one is **dropped, not truncated**, and the drop is
   reported as the existing `extension_failed { reason: "invalid_event" }`. A mutilated
   payload silently recorded would be worse than a missing one: the log is an audit
   artifact, and a half-recorded judgment is a lie.

3. **Flood control: 50 events per turn, then one visible warning.** Counting is
   per-extension and per-turn. The 51st and later events in the same turn are dropped and
   the extension gets a single `extension_failed { reason: "event_cap" }` for that turn —
   a buggy loop (or a runaway use case) cannot bury the log or the transcript in one turn,
   and the extension is never silently speechless. *#846 deviation:* the cap also
   overlays the extension's footer status with the degraded text for the remainder of the
   turn (the headless stderr line rides the same seam), cleared at the next turn and by
   the extension's own next `setStatus` — the degraded state is visible where the user
   looks, not only in the log. The audit-integrity clause is unchanged: nothing is
   sampled or truncated, and a producer whose volume legitimately reaches the cap
   (Jev's per-call guardrail records, before #846's turn aggregation) must reduce its
   volume rather than accept routine degradation. *#980 deviation:* the same rule applied
   to the anti-injection use case, whose per-tool-result records reached the cap on an
   ordinary `fetch`-heavy turn — one warning, the judgments that mattered, first. Its
   passing tool-result judgments now land as one per-turn aggregate
   (`useCase: "injection_passes"`, count and call ids), while `warn` and the withholding
   `confirm` band keep one record each, unsampled.

4. **Redaction heuristic on the payload.** Keys whose normalized form (lowercased, `_`
   and `-` stripped) is exactly `apikey`, `apitoken`, `accesstoken`, `refreshtoken`,
   `token`, `secret`, `clientsecret`, `password`, `passwd`, `authorization`,
   `credentials`, `privatekey`, or `sessionkey` have their value replaced with
   `"[redacted]"`, recursively through nested objects and arrays (depth cap 6). A
   safety net, not a guarantee: the contract documents that extensions must never put
   credentials in a payload in the first place, and the Jev client never does.
   Exact-match (not substring) keeps legitimate keys like `tokens` or `tokenCount` intact.

5. **Delivery is immediate and ordered.** `appendEvent` rides the runtime's existing
   event channel (`onLoadEvent` → the session's append), so a judgment lands in the log
   at the moment it happens, in order with the surrounding chrome — not batched at a
   flush point. The pre-subscription buffer (the window where the session has not yet
   attached, e.g. during `setup`) still drains via the existing
   `consumeLoadEvents` path, so nothing recorded early is lost or reordered.

6. **`setStatus`: one status per extension, replacing.** The key is the extension name;
   `null` clears it. Named multi-status was rejected as unused surface that would crowd
   the footer. Text is the extension's own string, rendered dim and truncated to the
   available width; several extensions' statuses render as separate chips in
   registration order, next to the existing MPM chip.

7. **Statuses are ephemeral.** Never written to the JSONL log, never persisted; cleared
   at session end and on hot-reload (a reloaded extension re-publishes from `setup`).
   Rationale: a status is a statement about *now*, and replaying a stale "offline" chip
   from last week would be actively misleading. Anything durable belongs in
   `appendEvent`.

8. **Headless: the first publish of a status writes one stderr line.** A repeat of the
   same text prints nothing, a clear prints nothing. This gives `moh run` the outage
   signal the guardrail ratified, without resurrecting per-call spam. Exit code is never
   affected: a status is information, never an error.

9. **Neither seam touches permissions.** `appendEvent` and `setStatus` are observation
   only: no path through them grants, denies, or modifies a tool decision, and neither
   is consulted by the permission gate. The veto-only principle stands unchanged —
   extensions still cannot widen what the user allows, and the new powers are exactly
   the two the loop cannot be influenced by.

10. **Never model context.** `extension_event` is chrome: it is never fed to the model,
    never a turn error, and the prompt assembly ignores it. An extension that wants the
    model to see something still uses `appendToPrompt` (or a hook return value), which
    stays the single, explicit door for that.

## Consequences

- `AgentEvent` gains one chrome variant; `AgentEventBase` in
  `packages/core/src/types.ts` and the TUI transcript renderer both grow by that one case
  (a dim single line: the event `name` plus, when the client recognizes it, a short
  summary; unknown names render as the bare name — the renderer stays generic).
- Consumers to touch: `packages/extension/src/index.ts` (contract + apiVersion `1.1`),
  `packages/core/src/extensions.ts` (stamping, validation, cap, redaction, status store),
  `packages/core/src/session/session.ts` (status accessor for clients + the same append
  path), `packages/tui` (transcript line + footer chip + Settings docs where relevant),
  `packages/cli` headless stderr line.
- The headless status line is decided by the session, not the extension: an extension
  cannot write to stderr today and this ADR does not add that door.
- Specs updated: `docs/spec/jev-infra.md` §4 (§4 becomes normative-by-reference to this
  ADR), and the guardrail spec (#802) consumes both seams.
- Rejected: core-known event types per use case (core couple to Jev), self-declared
  extension attribution (impersonation), truncating payloads (a half-recorded audit
  entry), unlimited volume (log flooding), multi-status per extension (unused surface),
  persisted statuses (stale chrome in replay), silent drops (violates the
  visible-diagnostic rule), redaction by substring (would eat legitimate keys),
  extensions writing to stderr directly (a new I/O door for bundled code).
