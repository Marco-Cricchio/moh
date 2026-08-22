# 0005 — Single session-assembly path (`sessionFromConfig`)

Date: 2026-08-22 · Status: accepted · Refs: `docs/spec/session-assembly-unification.md`, ticket #100, `docs/principles.md` (1, 3), ADR-0004

## Context

Session assembly was written twice — `packages/tui/src/factory.ts makeSession`
and `packages/cli/src/run.ts` — with the same choreography (moh.json read,
project+user MCP merge, provider resolution, subagent/memory wiring,
`createSession`) already diverging in error handling and MCP consent routing.
Provider resolution alone had three entry points: `resolveProviderRef`,
`resolveProvider` + a silent `MockProvider.demo()` fallback in the TUI
factory, and a third inline variant in `run.ts`. Worst hazard: a broken
moh.json made the TUI silently swap in the demo provider — the user thought
they were talking to their configured model.

## Decision

**One core-level builder owns the whole assembly; clients inject only their
seams; there is no silent fallback.**

- `sessionFromConfig({ cwd, home?, config?, provider?, providerRef?,
  consent?, overrides? })` in `packages/core/src/session/from-config.ts` is
  the single owner of: moh.json read, project+user MCP server merge,
  provider resolution, subagent/memory wiring, store creation, and session
  creation. It returns an explicit `{ session, store } | { error }` result
  (`AssemblyError`: `config` | `provider` | `session`).
- **Deliberate behavior change (the only one).** The silent demo fallback is
  removed. A broken config or provider reference surfaces as a visible
  error: the TUI shows a toast pointing at onboarding/moh.json; the CLI
  exits 2 with the message. The demo provider runs only when explicitly
  configured (`"mock"`, the zero-config default) or passed in as an
  instance. This is a repair, not a regression — the spec relaxes the
  behavior-identical rule for exactly this path.
- Client differences survive only as injected seams: the TUI passes its
  permission/ask-user modal seams (project MCP consent routes through the
  same permission modal); the CLI passes none (headless fail-fast) plus its
  `--allow/--deny` rules as `permissionFlags`, merged by the builder on top
  of moh.json overrides (caller wins). Neither client resolves providers,
  reads moh.json for assembly, nor merges MCP servers by hand anymore.
- The builder creates the store only after config/provider validation, so a
  broken config leaves no orphan session file; a still-empty store means
  "fresh append", a non-empty corrupt log is a visible `session` error.

### Public surface (against the ADR-0004 criterion)

One new export group, justified: `sessionFromConfig` plus its option/result
types (`SessionFromConfigOptions`, `SessionFromConfigResult`,
`SessionOverrides`, `SessionConsent`, `AssemblyError`,
`AssemblyErrorKind`). ADR-0004's criterion admits "what a client touches
today" — the TUI and the CLI both call this builder as their assembly
entrance, so it is a client-facing surface by definition. Consolidation
also lets `createSession`-era helpers leave the clients:
`tui/factory.ts` no longer exports `resolveDefaultProvider` (deleted with
the fallback) or `declaredServersFor` (the merge moved into the core).

## Consequences

- New assembly behavior changes happen in one place and both clients get
  them; the three provider-resolution paths are one.
- `moh run` with a broken moh.json now fails loudly instead of proceeding
  on demo output; the TUI tells the user to re-run onboarding or fix
  moh.json instead of silently degrading.
- The zero-config story is unchanged: no moh.json at all still assembles
  the mock demo (that default is explicit in `resolveProvider`, not a
  fallback on failure).
