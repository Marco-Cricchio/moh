# 0003 — Decompose AgentSession into internal collaborators

Date: 2026-08-22 · Status: accepted · Refs: `docs/spec/session-decomposition.md`, tickets #88–#92, `docs/principles.md` (1, 2)

## Context

`packages/core/src/session.ts` grew to ~790 lines doing seven jobs: append-only
event log, send queue/steering pump, agent turn loop, tool execution, permission
gate (including moh.json persistence writes), the post-turn memory trigger plus
`createMaintenanceExtractor`, and all constructor wiring. The loop itself is
healthy; the accumulated side-jobs break locality and make the file the
codebase's gravity well — every new feature lands there.

## Decision

Restructure — not redesign. `AgentSession` remains the single public class and
the only export surface of the session; its side-jobs move into internal
collaborators, delivered as five risk-ascending tracer-bullet tickets (#88–#92):

- `memory.ts` gains the post-turn trigger (`MemoryRunner`) and
  `createMaintenanceExtractor` (moved from session.ts);
- later tickets extract `event-log.ts`, `permission-gate.ts`, `tool-runner.ts`,
  `agent-loop.ts` + `turn-queue.ts` into a `session/` directory, with
  `session.ts` as a thin director.

Observable behavior, event stream, and public API are unchanged (spec
§Invariants); `createMaintenanceExtractor` moves between modules but keeps its
signature and remains exported from `@moh/core`.

A memory-module detail: `memory.ts` cannot statically import `AgentSession`
(`createMaintenanceExtractor` spawns it as the maintenance subagent) because
that would create a load-time cycle with `config.ts`, which reads
`memoryConfigSchema` at module evaluation. The import is therefore dynamic,
inside the extractor function.

## Consequences

- Each collaborator can be read and tested in isolation; session.ts shrinks to
  composition plus the turn loop (until ticket 5 extracts that too).
- No new public exports: collaborators are internal to `@moh/core`.
- `CONTEXT.md` glossary gains each collaborator name as its ticket lands.
- The maintenance extractor's child session still bypasses the spawn tool, has
  no tools and no memory of its own (no recursion), exactly as before.
