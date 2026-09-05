# 0006 — Single owner for `~/.moh/config` (the user-config guardian)

Date: 2026-08-24 · Status: accepted · Refs: ticket #102, `docs/principles.md` (5), ADR-0004

## Context

`~/.moh/config` had four owners and no owner: `tui/src/user-config.ts` (TUI chrome, whole-file rewrite), `cli/src/mcp.ts` (its own private `readUserMcpServers`/`writeUserMcpServers`), `core/src/mcp.ts` (`loadUserMcpServers`, default path), and the TUI factory (path spelled inline). The path was hand-spelled in four files; the TUI's `saveUserConfig` serialized the whole file, dropping any keys it did not know — meaning a TUI settings toggle could silently erase a user's `mcpServers`, and concurrent writers (live TUI + `moh mcp add`) could clobber each other. The file's format was governed by nobody.

## Decision

**A single core module owns the file; all writes are preservation-mandatory.**

- `packages/core/src/user-config.ts` is the **guardian**: the one `userConfigFile(home)` path constant (nothing else in the repo hand-spells `.moh/config`), plus `readUserConfigFile` and `updateUserConfigFile` helpers exported from the curated index (ADR-0004 keep-criterion: both TUI and CLI call them).
- **Preservation-mandatory writes.** `updateUserConfigFile` is the only write path: read-modify-write of the whole JSON object, so unrelated keys and unknown sections survive every write. No caller ever serializes the file itself. Writes are temp-file + rename (atomic within the process's reach; cross-process locking is explicitly out of scope).
- **Section schemas live with their domains; the guardian owns structure, not field validation.** Known sections today: TUI chrome (flat top-level keys; schema and field-by-field coercion stay in the TUI, which owns that domain) and `mcpServers` (`mcpServerEntrySchema` stays in `core/src/mcp.ts`, which keeps `loadUserMcpServers`/`declaredUserMcpServers` as thin typed readers over the guardian). The guardian itself is section-agnostic and tolerant of unknown sections — a future section needs no guardian change.
- **Reads degrade to `{}`**: missing, empty, or corrupt files read as an empty object; user chrome never hard-fails a session. Existing files read back identically — no migrations, no key renames (format-compatible invariant).

## Consequences

- The four former owners became callers: the TUI re-exports the guardian's path constant and routes `loadUserConfig`/`saveUserConfig` through it (`saveUserConfig` now preserves unknown keys instead of dropping them — a bug fix, not a behavior change any test observed); `cli/src/mcp.ts` lost its private read/write; `loadUserMcpServers` and `sessionFromConfig` use the constant.
- Enforcement is by grep: after landing, `git grep 'join(home, ".moh", "config")'` matches only the guardian. New access sites import `userConfigFile` (or the helpers) from `@moh/core`.
- Re-opening risk (ADR-0004): three new core exports (`userConfigFile`, `readUserConfigFile`, `updateUserConfigFile`, plus `UserConfigData`), all justified by direct client use.
