# Spec: Single session-assembly path in the core

Status: agreed · Origin: codebase-health re-survey (opportunity: session-assembly duplication + provider resolution spread) · Related: `docs/principles.md` (1, 3), ADR-0004 (surface criterion), ADR-0005 (to be written with this work)

## Problem

Session assembly is duplicated: `packages/tui/src/factory.ts makeSession` and `packages/cli/src/run.ts` both read moh.json, merge project+user MCP servers, resolve the provider, and wire `createSession` — same choreography written twice, already divergent (error handling, MCP consent routing). Provider resolution itself has three entry points (`resolveProviderRef` in session, `resolveProvider` + silent `MockProvider.demo()` fallback in the TUI factory, a third variant in `run.ts`). Worst hazard: on a broken moh.json the TUI silently swaps in the demo provider with no signal to the user.

## Decisions (from grilling)

1. **Full unification.** One core-level builder owns the whole choreography — including provider resolution (three paths become one).
2. **Deliberate behavior change (the only one).** The silent demo fallback is removed. A broken provider config surfaces as a visible error (clear message to the user; the TUI may offer re-running guided onboarding). The demo provider runs only when explicitly configured. This is a repair, not a regression: the spec explicitly relaxes the behavior-identical rule for this one path.
3. **Location & surface.** New dedicated module in the core (e.g. `session/from-config.ts`), exported from the curated public index as a deliberate, documented new door per the ADR-0004 criterion.
4. **Legitimate client differences preserved.** The builder accepts the client's consent/interaction seams (TUI: interactive permission + MCP consent; CLI headless: fail-fast denials). Everything else identical.
5. **Delivery.** One ticket, one PR to `develop` (touches core, tui, cli), ADR-0005 documenting the unified path and the removed silent fallback, two-axis review before merge.

## Builder shape (indicative)

```
sessionFromConfig({
  cwd, home?,            // where moh.json and ~/.moh live
  config?,               // pre-loaded MohConfig (tests); default: read from disk
  providerRef?,          // explicit override (CLI flag)
  consent: {             // the client seams
    onPermissionRequest?, onAskUser?, onMcpTrust?
  },
  overrides?: { permissions?, memory?, subagents?, ... }
}) → { session: AgentSession } | { error: AssemblyError }
```

Exact signature to be settled by the implementer against the real code; the contract is: one path, explicit result (no silent fallbacks), client seams injected.

## Invariants

1. **Everything except the silent-fallback path behaves identically.** Same events, same ordering, same permission/MCP semantics.
2. **The unified path is the only one**: after this lands, neither TUI factory nor CLI run resolves providers or merges MCP servers by hand.
3. Tests: existing suite green (CLI/TUI assembly tests updated to the builder); new tests cover the visible-error path and the explicit-demo path.
4. Public surface: exactly one new export (`sessionFromConfig` + its error/result types), justified in ADR-0005 against the ADR-0004 criterion.
