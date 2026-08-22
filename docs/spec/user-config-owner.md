# Spec: Single owner for ~/.moh/config

Status: agreed · Origin: codebase-health re-survey (opportunity: user-config multi-owner) · Related: `docs/principles.md` (5), ADR-0006 (to be written with this work)

## Problem

`~/.moh/config` has four owners and no owner: `tui/src/user-config.ts` (TUI chrome), `cli/src/mcp.ts` (its own private `readUserMcpServers`/`writeUserMcpServers`), `core/src/mcp.ts` (`loadUserMcpServers`, default path), and `tui/src/factory.ts` (path spelled inline). The path is hand-spelled in 4 files; ≥3 sites do read-modify-write of the whole JSON, so concurrent writers (e.g. live TUI + `moh mcp add`) can clobber each other's unrelated keys. The file's format is governed by nobody.

## Decisions (from grilling)

1. **The guardian owns the format.** A single core module (e.g. `core/src/user-config.ts`) owns the file: one path constant (`userConfigFile(home)`), one typed schema covering the file's known sections (TUI chrome, `mcpServers`), tolerant of unknown sections.
2. **Preservation-mandatory writes.** Every write is read-modify-write through the guardian and must preserve unrelated keys and unknown sections. No caller ever serializes the whole file itself. (Best-effort within process; cross-process atomicity via temp-file+rename is welcome if cheap.)
3. **Full cleanup.** All four current access sites become callers of the guardian; every hand-spelled `join(home, ".moh", "config")` in the repo is replaced by the single constant. No new hand-spelled paths.
4. **ADR-0006** records the single-ownership decision and the schema; CONTEXT.md glossary updated (guardian name; the file's two known sections).

## Invariants

1. **Behavior identical**: same values read/written at the same moments as today; all tests green (import-path-only edits allowed in tests).
2. **File format compatible**: an existing `~/.moh/config` written by today's code must read back identically through the guardian (no migrations, no key renames).
3. **Guardian is the only writer**: after landing, `git grep` for the config path outside the guardian module returns nothing.

## Delivery

One ticket, one PR to `develop`: guardian module + schema, the four call-site conversions, path-constant cleanup, ADR-0006, glossary update. Two-axis review before merge.
