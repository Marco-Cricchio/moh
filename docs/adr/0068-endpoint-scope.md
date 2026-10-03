# Endpoint scope: `endpoint:<ref>` calls configured endpoints; provider registration is deferred

The #996 destination phrase "programmable providers" carried two readings: an extension *calling* a configured endpoint through the host seam, or an extension *registering* a new provider (extension-supplied provider code). This ADR names the first and explicitly defers the second.

## Decision

- **`endpoint:<ref>` is calling only**: `ctx.host.modelCall({ endpoint, model, messages, ... })` asks the host for a single model call against a user-configured endpoint; moh executes it through the Route. Single-shot per call, no host-managed loop; the extension may issue as many calls as its logic needs — the owner sees every one in the log and the usage in `done`. Credentials never reach extension code.
- **One ref per grant, catalog included**: `endpoint:zen` grants that endpoint; an extension holding the scope may also list that endpoint's models. The consent sentence states both ("may call and list the models of `zen`").
- **Thinking level: per-call override within capability**: the extension may request a thinking level per call, bounded by the model's thinking capability — outside levels are a typed refusal, never a remapping. The power is declared in the consent sentence ("may choose the reasoning level per call, within those supported"), so no silent override of the endpoint's configured level; the recorded `model_call` carries the effective level sent (#240). The glossary's *Thinking level* stays the user-selected default for the endpoint; the scope grants a bounded deviation from it, visibly.
- **Provider reasoning not persisted**: a host-performed call is not part of the conversation; its provider reasoning is not written to the log. Tokens count.
- **Provider registration deferred**: `registerProvider` stays an embedding-program door, frozen at session creation. Extension-supplied provider code is a different trust shape with a session-lifecycle problem; if the need is real, it gets its own ticket — this scope never names it.
- **Log**: the same `model_call` event, marked `requester: "extension:<name>"` — the `done` rollup and usage surfaces separate by requester, so the owner sees which extension consumed tokens. No parallel event type: duplicating the model_call shape would split the rollup.

## Considered options

- Extension provider registration in this phase — rejected: extension-performed backend code plus a lifecycle the seam does not own; deferring keeps "programmable providers" honest instead of half-true.
- A separate `extension_model_call` event — rejected: duplicates the model_call structure and splits usage accounting.

## Consequences

All five scope grammars are now fixed (ADR-0065/0066/0067 and this one, custody pending in #1148); #1152 (phases and migration) can sequence them. A future provider-registration decision must reuse this ADR's requester-marking for attribution.
