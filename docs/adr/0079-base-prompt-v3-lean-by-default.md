# ADR-0079: Base prompt v3 — lean by default as product behaviour

Status: accepted · Date: 2026-10-23 · Supersedes: ADR-0073 (base prompt v2)
Related: ADR-0078 (principle 8), ADR-0072 (moh_docs), #1633 (this change), #731 (rg absent)

## Context

Principle 8 (ADR-0078) governs changes to moh and reaches nobody else: its
checks are tests of this repository, and its text is read only by a
contributor working in this checkout. A user pointing moh at their own
repository got a v2 base prompt whose Code section forbade abstractions
beyond the task but said nothing about reusing what exists, keeping one fact
in one place, or deleting what a change leaves unused; and `moh init`
scaffolded nothing about code quality, although AGENTS.md is the one channel
every harness reads.

## Decision

**Base prompt v3** replaces v2 in `BASE_PROMPT`
(`packages/core/src/prompt-composer.ts`). Its Code section carries principle
8's posture: every abstraction needs a caller in the same change; one fact
(a list, map, constant) lives in one place, while three similar lines still
beat a premature abstraction; find and extend the existing helper or file
before writing one; delete what the change leaves unused.

v3 also ships the prompt revisions accumulated since v2, because the base
prompt is one versioned artifact:

- a **Tool use** section (dedicated tools over bash, parallel independent
  calls, quiet output, searches inside the working directory);
- a **Review** section (findings first by severity with `path:line`; with no
  findings, name the untested residual risks);
- **Actions** hardened: rewriting or destroying git history (`reset --hard`
  included, moved from "confirm" to "never") only when explicitly asked; no
  bypassing a safety check; never presenting unverified work as done or
  purging an exposure instead of reporting it;
- **Working**: a question, diagnosis or review authorizes analysis, not a
  change;
- **Security**: insecure code is flagged and fixed when in the task's scope
  (v2's "fix on sight" contradicted "nothing beyond the task"); secrets are
  never committed.

**Excluded, with reasons:** a preference for `rg` over `grep` — moh ships a
`grep` tool and `rg` is often absent (#731); the full rules (a)–(f) of
principle 8, which are moh's idiom (entry-surface exports, `…ForTests`
hooks, real temp files instead of seams) and would fight a repository whose
idiom differs.

**Principle 8 is amended, not duplicated**: its title and first sentence are
also product behaviour in a user's repository, where that repository's
conventions govern; (a)–(f) are scoped to this repository.

**`moh init`** scaffolds `docs/agents/code-quality.md` with the posture in
user-facing terms and points to it from the AGENTS.md moh section, so the
rule travels with the repository to any harness.

## Consequences

- The `promptVersion` hash shifts; informational.
- Prompt-matching tests assert the lean Code lines and the absence of an
  `rg` preference.
- The posture stays prose: an executable structural gate is deferred to the
  measurement planned in #1633.
