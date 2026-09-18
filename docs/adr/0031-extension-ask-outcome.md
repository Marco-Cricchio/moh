# ADR-0031: extension `ask` outcome on the tool-call hook

Status: accepted · Date: 2026-09-18 · Parent: wayfinder map #799, ticket #800 (feature #784)

## Context

The extension contract (`@moh/extension`) lets a phase hook **restrict** tool calls and
never grant them: `onToolCall` returns `{ veto: true; reason?: string }` and the core's
`PermissionGate` honours it before any user rule, in every mode including yolo.

That contract has exactly two positions: the hook decides nothing, or it kills the call.
The Jev guardrail (#786) needs a third position — the call is neither clearly safe nor
clearly dangerous (calibrated confidence in the middle band, e.g. `rm -rf /tmp/build`
at `destructive: 0.42`). Killing it forces the model to route around a case a human
could settle in one keystroke; letting it through discards the judgment.

moh already owns the surface that case needs: the permission gate's **ask flow**
(`onPermissionRequest`, the `permission_requested` → `permission_granted`/`permission_denied`
chrome pair, `auto-accept`/`yolo`/headless handling). The missing piece is a way for a
hook to hand a call to it.

## Decision

**Go.** Add an optional `ask` outcome to `ToolCallHookResult`. An extension gains the
ability to escalate a call to the user's existing consent flow — never to grant one.

```ts
export interface ToolCallHookResult {
  readonly veto?: true;   // unchanged: kill the call
  readonly ask?: true;    // new: hand the call to the human consent flow
  readonly reason?: string;
}
```

Key decisions, each with its rationale:

1. **Additive field, not a redesigned return type.** `{ veto: true }` keeps working
   byte-for-byte; `ask` is a new optional key. A discriminated union
   (`{ decision: "veto" | "ask" }`) would break every published extension for a
   cosmetic gain. The contract stays additive-only, as its apiVersion policy promises.
   A hook returning both `veto` and `ask` is contradictory: **veto wins** (the more
   restrictive outcome), documented rather than rejected at runtime.

2. **`ask` is not a grant.** It can only route a call to the human confirmation flow.
   It never produces `permission_granted` on its own, never writes a permission rule,
   and the offer of "always" is deliberately withheld: an ask born from a false
   positive must not disarm the filter that produced it. This keeps the veto-only
   principle intact — the hook still cannot hand out permissions; it can only hand out
   a question.

3. **Precedence: hooks first (unchanged), rule `deny` beats the ask.** The gate keeps
   its current order — hook, then rules, then ask flow. An explicit user `deny` rule
   still wins over an extension ask (no prompt: the user's written intent outranks a
   model judgment), while an explicit `allow` rule does **not** suppress it (the guard
   rail's whole point is judging what the rules already let through). `veto` continues
   to beat everything, including rules and yolo.

4. **Mode semantics.** The ask is evaluated **before** the mode branches, so:
   `ask` in **auto-accept** still reaches the user (the value of confidence gating —
   there is no other filter in auto-accept); `ask` in **yolo** is **ignored** (yolo is
   sovereign: zero prompts, the call proceeds as if the hook had said nothing — an
   extension that must stop something lethal in yolo uses `veto`); `ask` in **headless**
   degrades to `deny` (`permission_denied` with `reason: "headless"`), exactly as a
   non-extension ask does today, because there is no recipient.

5. **First decision wins, across extensions.** Hook collection is unchanged: instances
   run in registration order and the first hook returning a decision (`veto` or `ask`)
   short-circuits the rest. Composition (two asks coalescing into one prompt, veto
   outranking a collected ask) was rejected: it changes existing veto semantics for a
   case no real roster has.

6. **Logging reuses the gate's chrome.** An extension ask appends
   `permission_requested { callId, tool, reason: "extension" }`, symmetric with the
   existing `permission_denied { reason: "extension" }`. A separate `extension_ask`
   event type was rejected: the gate's consent trail stays one shape, so replay and the
   transcript render it like any other consent prompt, with the extension's `reason`
   as the label.

7. **apiVersion: minor bump, no runtime shim.** `{ ask: true }` received by an older
   runtime is an unknown key and is ignored — the call proceeds, which is fail-open and
   matches the degradation model the guardrail already ratified (a Jev that cannot be
   reached changes nothing about moh's behavior). The bump is documented in the
   contract; the extension side may check `apiVersion` if it wants to know. The runtime
   does not attempt to detect unknown decision keys.

## Consequences

- `PermissionGate.check` gains one branch between the veto check and rule resolution;
  `ToolCallHookResult` gains one optional field. No new public export from `@moh/core`
  (ADR-0004 untouched): `PermissionGate` is internal and the hook type lives in
  `@moh/extension`.
- The hook contract and its `ask` semantics must be documented in the `docs/extending`
  chapter for the extension writer, and the consent prompt with an extension label is
  user-visible copy for the manual. Both ship with the implementation PR (#784), not
  with this decision record.
- Rejected: discriminated-union return type (breaks published extensions), ask
  outranking an explicit rule `deny` (an extension would override written user intent),
  ask outranking yolo (a prompt in the mode chosen to never prompt), turning yolo asks
  into denies (an extension could silently block in yolo), an "always" option on an
  extension ask (self-disarming filter), a separate `extension_ask` event type (splits
  the consent trail).
- This ADR unblocks the guardrail (#786), whose middle band is the reason it exists;
  the routing (#787) and ★★ pack (#788–#793) use cases consume the same infra layer.
