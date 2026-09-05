# gh-manager integration as a TypeScript port in @moh/core (ADR-0017)

Issue #378 integrates the ideas of ddlaws0n/gh-manager (MIT) — declarative,
IaC-style GitHub repository management (`init → plan → apply` from a single
`repos.yaml`) — into moh's workflow mode.

## Decision

**Option A: TypeScript port inside `@moh/core`.** The plan/diff engine and
the GitHub access layer are re-implemented in TypeScript
(`packages/core/src/github-settings.ts`), exposed to agents as a bundled
first-party skill (`packages/core/assets/skills/gh-manager/`). No Python
dependency, no external runtime: the compiled binary (ADR-0013) stays
self-contained and all agent logic keeps living in the headless core.

**Option B (rejected): a wrapper skill that detects `gh-manager` on PATH.**
Cheaper, but it makes moh's value depend on a third-party MVP and a Python
runtime, contradicting the binary's self-containment and the "core owns the
logic" principle.

## Consequences

- gh-manager remains the credited inspiration: David Lawson (@ddlaws0n)
  is credited in the CHANGELOG, README, skill header and NOTICE.md (MIT).
- `apply` is agent-driven and consent-gated at the skill level: the skill
  must show a rendered diff and obtain explicit user consent before any
  mutating call. The module itself never mutates without being asked.
- Token handling follows the repo's existing pattern (`gh` CLI / `gh api`,
  auth resolved by `gh`), never persisting secrets in config.
- No first-party skill file is modified except the additive routing
  description in `ask-moh`.
