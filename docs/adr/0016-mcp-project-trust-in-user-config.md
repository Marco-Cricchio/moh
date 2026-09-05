# ADR-0016: Project MCP trust lives in the user config

Status: accepted · Date: 2026-08-31 · Issue: #352 (audit SEC-01)

## Context

Project-scope MCP servers (declared in the repo's `moh.json`) ask consent on
first start; answering "always" used to persist `trusted: true` back into
`moh.json`. But `moh.json` is repository-controlled: a cloned repo could ship
`trusted: true` itself, skipping consent entirely, spawning the server's
stdio command on the first turn and auto-allowing every tool it lists. The
security audit (v0.8.0, SEC-01) rated this high severity.

## Decision

Persisted trust for project MCP servers moves to the **user config**
(`~/.moh/config`, owned by the user-config guardian per ADR-0006), in a new
known section `mcpTrust`: a record keyed by absolute project path → list of
consented server names. Trust is therefore per-project: the same server name
declared in a different project still asks.

- The `trusted` field of a project `moh.json` entry is **tolerated on parse
  but never read** — the repository cannot self-declare trust. On the
  resolved declaration (`DeclaredMcpServer.trusted`), trust is a property
  computed by moh from the user config, not a field of the repo's transport
  entry.
- `persistProjectMcpTrust` (mcp/types.ts) is the only writer; it goes through
  the guardian's read-modify-write. `sessionFromConfig` resolves trust at
  assembly time.
- User-scope servers are unchanged: they never ask (that trust is already
  user-owned).
- The guardian's known-section list (ADR-0006) gains `mcpTrust`, schema owned
  by the MCP module like `mcpServers`. The alternative — an moh-owned marker
  under `~/.moh` — was rejected: the guardian already owns consent-adjacent
  state with the right file hygiene.

Out of scope (tracked separately in the audit): a minimal environment for
stdio servers (SEC-09), re-consent on manual restart (SEC-13), decoupling
"trusted server" from "tools auto-allowed".

## Consequences

- Cloning a repo can never again auto-start a project MCP server: consent is
  asked at least once per project+server pair, in a store the repo cannot
  write.
- Existing configs that carry `trusted: true` in `moh.json` load unchanged,
  but users who relied on it will be asked for consent once more; "always"
  then persists to the user config.
- `/skills update`-style consent UX is unaffected; only the persistence
  target moved.
