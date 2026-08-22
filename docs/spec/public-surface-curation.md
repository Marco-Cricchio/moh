# Spec: Curate the @moh/core public surface

Status: agreed · Origin: codebase-health re-survey (opportunity: index.ts barrel) · Related: `docs/principles.md` (1, 6), ADR-0004 (delivered with this work)

## Problem

`packages/core/src/index.ts` (397 lines) re-exports ~90 symbols — including test-only providers (`MockProvider`, `EchoProvider`), memory internals exported for test convenience (`MAX_ENTRIES_PER_TOPIC`, `topicFileName`, `CHARS_PER_TOKEN`, …), MCP plumbing constants, and workflow/tracker tooling — and additionally *defines* `SessionConfig`/`PermissionsConfig`, which internal modules then import from the barrel (a layering smell: `session/*` files importing from `../index`). The package is not yet published (v0.1.0, workspace-only); every export that ships at first publish becomes a de-facto perpetual contract.

## Goal

Shrink the public surface to what real consumers need, before publish makes it expensive. Not a redesign: no behavior change, no module moves beyond what's listed.

## Decisions (from grilling)

1. **Single curated entry.** One `index.ts`; no subpath exports now (`@moh/core/testing` etc. can be added deliberately later if real external need appears).
2. **Mechanical keep-criterion.** A symbol stays exported **only if** `@moh/tui`, `@moh/cli`, `@moh/extension`, or a user-facing config surface touches it today. Everything else becomes internal: tests import directly from the defining module (`./memory.js`, `./mock-provider.js`, …).
3. **Close doors now.** Removal from the barrel is allowed and expected; the unpublished status makes this the one free window. Re-opening a door later is an explicit, recorded decision (ADR).
4. **SessionConfig moves home.** `SessionConfig`/`PermissionsConfig` move out of `index.ts` into `session/` (own file or types, whichever fits); internal files stop importing from the barrel. `createSession`/types remain exported for clients.
5. **Test providers leave the public surface.** `MockProvider`/`EchoProvider` stay in `src/` but are not exported from the barrel; tests import them directly.
6. **ADR-0004** records the criterion ("the official entrance exports what a client or extension needs to live; everything else is internal; re-opening a door is an explicit decision") plus the reasoned keep-list. CONTEXT.md glossary gains the criterion and any new internal names.

## Invariants

1. **Behavior identical**: all 354 tests pass and typecheck is clean; test edits limited to import paths.
2. **TUI and CLI compile unchanged in behavior**; any symbol they actually use remains exported.
3. The extension package's contract (`@moh/extension`) is untouched.

## Delivery

One ticket, one PR to `develop` containing: slimmed `index.ts`, `SessionConfig` relocation, test import updates, ADR-0004, CONTEXT.md glossary update. Two-axis review before merge.
