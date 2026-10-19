# Endpoint scope: `endpoint:<ref>` calls configured endpoints; provider registration is deferred

The #996 destination phrase "programmable providers" carried two readings: an extension *calling* a configured endpoint through the host seam, or an extension *registering* a new provider (extension-supplied provider code). This ADR names the first and explicitly defers the second.

## Decision

- **`endpoint:<ref>` is calling only**: `ctx.host.modelCall({ endpoint, model, messages, ... })` asks the host for a single model call against a user-configured endpoint; moh executes it through the Route. Single-shot per call, no host-managed loop; the extension may issue as many calls as its logic needs — the owner sees every one in the log and the usage in `done`. Credentials never reach extension code.
- **One ref per grant, catalog included**: `endpoint:zen` grants that endpoint; an extension holding the scope may also list that endpoint's models. The consent sentence states both ("may call and list the models of `zen`").
- **Thinking level: per-call override within capability**: the extension may request a thinking level per call, bounded by the model's thinking capability — outside levels are a typed refusal, never a remapping. The power is declared in the consent sentence ("may choose the reasoning level per call, within those supported"), so no silent override of the endpoint's configured level; the recorded `model_call` carries the effective level sent (#240). The glossary's *Thinking level* stays the user-selected default for the endpoint; the scope grants a bounded deviation from it, visibly.
- **Provider reasoning not persisted**: a host-performed call is not part of the conversation; its provider reasoning is not written to the log. Tokens count.
- **Provider registration deferred**: `registerProvider` stays an embedding-program door, frozen at session creation. Extension-supplied provider code is a different trust shape with a session-lifecycle problem; if the need is real, it gets its own ticket — this scope never names it.
- **Log**: the same `model_call` event, marked with the requester —
  `requester: { kind: "extension", extension: "<name>" }`, the structured
  shape the subagent spawn records already use — so the `done` rollup and
  usage surfaces separate by requester, and the owner sees which extension
  consumed tokens. No parallel event type: duplicating the model_call shape
  would split the rollup.

## Considered options

- Extension provider registration in this phase — rejected: extension-performed backend code plus a lifecycle the seam does not own; deferring keeps "programmable providers" honest instead of half-true.
- A separate `extension_model_call` event — rejected: duplicates the model_call structure and splits usage accounting.

## Consequences

All five scope grammars are now fixed (ADR-0065/0066/0067 and this one, custody pending in #1148); #1152 (phases and migration) can sequence them. A future provider-registration decision must reuse this ADR's requester-marking for attribution.

## Amendment — ablation (2026-10-19)

The decision above is unchanged. This amendment records where the `endpoint:` scope lives after #1424 (S3.2, delivered by #1571), the prerequisite recorded for this ADR. It adds no decision.

### What changed

- Before #1571 the scope was in `packages/core/src/endpoint-scope.ts`: `ENDPOINT_SCOPE_PREFIX`, `isEndpointScope`, `endpointScopeRef`, `validateEndpointScope`, `endpointScopesOf`, `checkEndpointScope` and the effect-sentence function `endpointEffectSentence`. For this scope, `packages/core/src/scope-effect.ts` dispatched `isEndpointScope` capabilities to `endpointEffectSentence(endpointScopeRef(…))`, and `packages/core/src/check-scope.ts` dispatched the `endpoint` kind to `checkEndpointScope`.
- Those definitions are now in `packages/core/src/scopes.ts`. `ENDPOINT_SCOPE_PREFIX`, `isEndpointScope`, `validateEndpointScope`, `endpointScopesOf`, `checkEndpointScope` and `endpointEffectSentence` are still exported from there; `endpointScopeRef` lost its `export` and is file-local. `endpoint-scope.ts`, `scope-effect.ts` and `check-scope.ts` no longer exist.
- The `endpoint` descriptor of the scope table in `scopes.ts` is new in #1571, with `prefix`, `validate`, `check` and `effectSentence`. Its `check` calls `checkEndpointScope`, and its `effectSentence` calls `endpointEffectSentence(endpointScopeRef(…))`.
- `ctx.host.modelCall` and the model listing still go through `checkScope`: `extensions.ts` calls `checkScope({ kind: "endpoint", … })` in both. For `checkScope` itself, see the amendment to ADR-0064.

### What stays

- The rules in the Decision section are unchanged: apart from the dropped `export` on `endpointScopeRef`, the declarations and function bodies of the names listed above are identical before and after #1571.
- The refusal reasons are unchanged, and each is still produced where it was. `validateEndpointScope` returns `malformed`, which the extension loader in `extensions.ts` reports as `invalid_endpoint_scope`. `checkEndpointScope` returns `outside_scope`. `unknown_endpoint` and `unsupported_level` are returned by the model seam in `session/session.ts`, and `failed` by that seam or by `extensions.ts` when no session is bound to the extension runtime; `extensions.ts` passes them on in the `ctx.host.modelCall` and listing results.
- The effect sentence is unchanged: "may call and list the models of `<ref>`; may choose the reasoning level per call, within those supported". The Decision section quotes its first part.
- The `model_call` record with `requester: { kind: "extension", … }`, the thinking-level handling and the Route resolution for the call are in `session/session.ts`; the `model_call` event type is in `types.ts`; the `host_op` audit lines are emitted in `extensions.ts`. #1571 does not touch `session/session.ts` or `types.ts`, and in `extensions.ts` it changes only import lines.
- `registerProvider` is not touched by #1571: `provider-registry.ts`, `config.ts` and `packages/extension` are not in its diff.
