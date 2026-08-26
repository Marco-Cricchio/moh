# ADR-0012: Automatic fallback chains from configured providers

- Issue: #234
- Status: accepted
- Date: 2026-08-27

## Context

The engine already supports route-level fallback chains (`createRoute({ target, fallbacks })`
in `core/src/route.ts`), but nothing can populate them: `resolveProviderRef` builds routes
of length 1, and no config field declares a chain. The v1 spec assumed **user-declared**
chains ("Route = `endpoint/model-id` with declared fallback chain (user-declared; no model
equivalence assumed)"), and ADR-0005 established "no silent fallbacks" after a session
assembly incident.

Issue #234 proposed a user-declared `providerFallbacks` array. During triage the owner
chose the opposite direction: **moh builds the chain automatically** from the providers
currently configured, starting from the one in use. A user with two configured endpoints
whose primary exhausts its quota gets automatic recourse today; requiring manual chain
declaration adds config surface for the same outcome.

## Decision

1. **Automatic chain construction.** When a route is assembled (initial provider
   resolution, `/model` switch, or `--provider`), moh derives the fallback chain from all
   configured, fallback-eligible providers, starting from the active one. A single
   configured provider yields a chain of length 1 — the mechanism simply does not engage.
2. **Health-based ordering.** Chain order follows estimated provider health / remaining
   quota where retrievable (higher remaining quota first). Providers whose quota data
   cannot be retrieved go to the **end** of the chain; declaration order breaks ties.
   **Scope note (implementation):** no builtin quota retrieval exists in moh today; the
   ordering is delivered via an injectable `ProviderHealthEstimator` seam exercised by
   tests, and real quota/health retrieval per provider kind is follow-up work (tracked
   on #234). Until then production chains are declaration-ordered — which is exactly
   the "data not retrievable" case of this rule.
3. **Opt-out per provider.** An endpoint profile flag (`fallbackEligible`, default
   `true`) excludes a provider from being an automatic fallback stop. This is the minimal
   user control — no ordering hints, no per-route declarations.
4. **Visible, not silent.** When a fallback fires (quota exhausted immediately; rate
   limit / network / overload after same-endpoint retries), the TUI surfaces a distinct
   notification ("quota exhausted on X — switching to Y"). This is what keeps the
   automatic chain compatible with ADR-0005: the fallback is explicit and visible to the
   user, never a silent model swap.
5. **No model equivalence assumed.** The chain contains concrete `endpoint/model-id`
   stops from configuration; moh never invents substitutions. Custom (registered-factory)
   providers cannot be route stops and are skipped. Mid-stream failure restarts the
   single-shot request on the next stop (existing engine behavior).
6. **Engine-announced stops.** When a fallback fires, the route engine emits a
   `fallback` event (`from`, `to`, `reason`) into the session log; the TUI turns it
   into a toast ("quota exhausted on X → Y") and the transcript keeps a durable
   chrome block for replay. Detection is event-driven, never inferred from
   model-name changes.

## Consequences

- The spec v1 wording "user-declared" is superseded by this ADR for fallback chains;
  the engine, the triggers, and the error taxonomy (`isFallbackWorthy`,
  `quota_exhausted`) are unchanged — the work is chain construction and wiring.
- Quota/health retrieval is provider-kind-dependent; providers without a quota endpoint
  are always ordered last. Health probing must not add latency to session startup —
  cached/stale estimates are acceptable for ordering.
- Config schema grows `fallbackEligible` on endpoint profiles (ADR-0006 merge semantics
  apply across user config and moh.json).
- `/model` switching rebuilds the chain around the newly selected provider automatically.
- The TUI must distinguish a fallback stop from a normal model_call in its notification
  layer (the route `chain` is already exposed on the `Route` interface).
