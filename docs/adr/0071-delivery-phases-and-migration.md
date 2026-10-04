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

## Shippability checklist — verified at phase close (T9, #1167)

Every shipped scope carries all three shippability requirements, verified against the shipped surface:

| Scope | Consent sentence | Log events | Typed refusals |
|---|---|---|---|
| `path:<glob>` (0065) | `scopeEffectSentence` | `host_op` / `host_refused` | `{ ok: false, reason: "outside_scope" }`, load-time `invalid_path_scope` |
| `host:<domain>` (0066) | `scopeEffectSentence` | `host_op` / `host_refused` | `outside_scope`, `missing_reasoning` for `host:*`, load-time `invalid_host_scope` |
| `credential:<ref>` (0069) | `credentialEffectSentence` | `host_op` / `host_refused` | unknown-ref loud typed refusal, load-time `invalid_credential_scope` |
| `tool:<name|*>` (0067) | `toolEffectSentence` | `host_op` / `host_refused` | `outside_scope`, unknown tool, load-time `invalid_tool_scope` |
| `contribute-tool:<name>` (0067) | `contributeToolEffectSentence` | `tool_contributed` at bind | consent-name mismatch refused, load-time `invalid_tool_scope` |
| `endpoint:<ref>` (0068) | `endpointEffectSentence` | `model_call` with `requester: "extension:<name>"` | capability-clamped thinking, outside-envelope refusal |

With all four phases shipped, the shipped prefixes are enforced at install/scan time: `scopeGrammarValidity` checks a capability against its prefix's grammar and a typo is a manifest error (the install refuses), never a warning the consent would echo; truly novel slots keep warning and load.

## Consequences

This is the phase plan `/to-spec` consumes; the map #996's decision work is complete.
