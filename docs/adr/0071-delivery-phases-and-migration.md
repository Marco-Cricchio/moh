# Delivery phases and migration: seam first, scopes in trust order, Jev migrates with its phase

All six scope arcs have resolved ADRs (0064–0070). This decision sequences their implementation, defines what makes a phase shippable, and fixes how the one existing extension migrates.

## Decision

**Four phases**, ordered by trust weight and dependency:

1. **Seam + path** (ADR-0064, 0065) — the `ctx.host` surface, the check-scope module, `host_op`/`host_refused` events, and the first concrete scope. The minimal end-to-end pair: every later phase inherits this machinery.
2. **Host + credential** (0066, 0069) — the network with custody; the two share a fixed boundary (an authenticated request needs both scopes).
3. **Tool + endpoint** (0067, 0068) — the strongest powers (running session tools, model calls) land on a mature seam.
4. **Extension-deps** (0070) — the installer; independent of the seam (it uses no `ctx.host`), may run in parallel with phases 2–3.

**A phase is shippable when each of its scopes has all three**: effect-sentence consent, per-operation log events, typed refusals. A scope with any of the three missing is not shipped.

**Jev migrates with its phase**: until a phase ships, Jev is unchanged (zero work in advance). When host+credential ship (phase 2), Jev's TypeSafe calls move to `ctx.host` with `host:api.typesafe.ai` + `credential:typesafe`, the API key moving from plain config to the credential store; when tool ships (phase 3), its git snapshots move to `tool:git` via the seam. No permanent exemption and no hardcoded exception: the core keeps knowing nothing Jev-specific (#826's invariant). Bundled posture is unchanged — Jev still skips file consent; what migrates is that its I/O crosses the same checkpoint as every other extension's.

**Scope prefixes become known slots at their phase's ship**: until then they ride the unknown-slot warning; from a phase's ship, its prefixes (`path:` … `endpoint:`, `contribute-tool:`) enter `KNOWN_CAPABILITY_SLOTS` — a typo in a shipped scope's grammar is a manifest error, never a warning the consent would echo as legitimate. Truly novel slots keep warning.

**No soft deprecations**: when a phase ships, its way is the only way for newly loaded manifests. The consent machinery (bytes-change → new question, `capabilityDiff` for widenings) already covers the transition with no code change.

## Consequences

This is the phase plan `/to-spec` consumes; the map #996's decision work is complete.
