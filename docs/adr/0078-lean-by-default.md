# ADR-0078: Principle 8 — Lean by default

Status: accepted · Date: 2026-10-14
Related: ADR-0004 (public-surface criterion), #1378 (ablation tracking), #1383 (decision D8), #1398 (this ADR), #1388, #1396, #1397, #1392–#1395

## Context

ADR-0004 set a keep-criterion for the `@moh/core` entry: a symbol stays only
if a client, the extension contract or a user-facing config surface touches
it. Nothing enforced it, so tests importing through the public barrels and
disabled unused-code checks let surplus accumulate: unused exports, optional
parameters no production caller passes, single-implementation interfaces and
parallel copies of the same fact.

## Decision

`docs/principles.md` gains principle 8, adopted as drafted in #1378
(section 7) and approved in #1383 (D8):

> **8. Lean by default: every door, option and abstraction has a caller.**
> A change adds only what a caller in the same change uses. Concretely:
> (a) export a symbol from a package entry only when another package imports
> it in the same change, or it is documented library/extension API; tests
> import from the defining module;
> (b) add a parameter, option or injection seam only when a production
> caller passes it — tests use real temp files and directories, scripted
> providers and local servers instead of new seams; a seam is justified only
> at a network, clock or process boundary that a test genuinely needs;
> (c) no interface with a single implementation unless it is a public
> contract or crosses a package boundary; no duck typing
> (`typeof x.m === "function"`, `as { m?: … }`) on a value whose type is
> known — widen the type instead;
> (d) one fact, one place: before adding a list or map keyed by provider,
> scope, use case or command, find the existing one and extend it; before
> writing a helper (atomic write, `git` runner, error message), find the
> existing one;
> (e) extend the existing module before creating a file; a new file is a
> new concept, not a new ticket;
> (f) a change that leaves code unused deletes it in the same change; test
> support code lives under `test/`, except hooks named `…ForTests`.
> Mechanical checks enforce (a), (b) partially, and (f): a change that fails
> them needs an explicit allowlist entry with a reason, visible in the diff.

The keep-criterion of ADR-0004 is now enforced mechanically:

- **G2** (#1388): `packages/core/test/entry-surface/` locks the names each
  package entry exports; additions and removals need an explicit list diff.
- **G3** (#1396): `packages/core/test/keep-criterion/` checks the `@moh/core`
  keep-criterion, with a reasoned allowlist and a shrinking historical
  baseline.
- **G4** (#1397): `packages/core/test/unused-exports/` ratchets unused
  source exports repo-wide (extension excluded).
- **G5** (#1392–#1395): the `noUnusedLocals` and `noUnusedParameters`
  compiler flags are enabled in every package configuration.

## Consequences

- A change that fails a check needs an allowlist entry with a reason, visible
  in the diff; the principle needs no further ADR for that.
- A change that violates principle 8 without an allowlist entry needs an ADR
  saying why, like any other principle.
- This ADR does not amend ADR-0004; its amendment is tracked separately
  (#1455).
