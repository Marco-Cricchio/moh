# 0003 — Decompose AgentSession into internal collaborators

Date: 2026-08-22 · Status: accepted · Refs: ticket #88–#92, `docs/principles.md` (1, 2)

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

- Each collaborator can be read and tested in isolation; `session/session.ts`
  is a thin director — constructor wiring plus the unchanged public surface.
  The `session/` directory layout is canonical (this shipped with ticket 5).
- No new public exports: collaborators are internal to `@moh/core`.
- `CONTEXT.md` glossary gains each collaborator name as its ticket lands.
- The maintenance extractor's child session still bypasses the spawn tool, has
  no tools and no memory of its own (no recursion), exactly as before.

## Amendment — ablation (2026-10-21)

The decision above is unchanged. This amendment records how the session
collaborators and the session's seams to the extension runtime look after
phase 4 of the ablation: #1438 (S4.3, delivered by #1596), #1439 (S4.4,
delivered by #1600) and #1440 (S4.5, delivered by #1601). It adds no decision.

### What changed

- One binding between `ExtensionRuntime` and its session (#1438). The five
  setters `bindRequestTurn`, `bindPathDeny`, `bindToolSeam`, `bindModelSeam`
  and `bindToolContributor` in `packages/core/src/extensions.ts` are replaced
  by one `bindSession(port: SessionPort)`. `SessionPort` is an interface local
  to `extensions.ts`; it is not exported. `AgentSession` calls `bindSession`
  once, in its constructor (`packages/core/src/session/session.ts`). Four of
  the closures that the constructor used to build (path deny, `runTool`,
  `modelCall`, `listModels`) are now the private methods `#seamPathDenied`,
  `#seamRunTool`, `#seamModelCall` and `#seamListModels`; `requestTurn` and
  `contributeTool` stay inline in the `bindSession` call.
  `ExtensionRuntimeOptions.requestTurn` and `ExtensionRuntimeOptions.isPathDenied`
  are removed; no construction in the repository passed them. Three behaviors
  that predate #1596 were left as they were and are tracked as #1597, #1598
  and #1599.
- The borrowed runtime is typed (#1439). `SessionConfig.toolHooks` is now
  `borrowedRuntime?: ExtensionRuntime` (`packages/core/src/session/config.ts`),
  by the owner's decision K-1 recorded on #1600. The `typeof … === "function"`
  probes and the `Pick<ExtensionRuntime, …>` casts for the borrowed runtime are
  removed from `session.ts`. `ToolHookChecker` (`session/permission-gate.ts`)
  and `ToolResultHookChecker` (`session/tool-runner.ts`) stay: the session
  passes them scoped wrapper objects, not a runtime.
- Concrete collaborators (#1440). `LoopToolRunner` in `session/agent-loop.ts`
  is removed; `AgentLoopOptions.toolRunner` is typed `ToolRunner`, the class in
  `session/tool-runner.ts`. In `session/turn-queue.ts`, `TurnQueue` types the
  attachment as `SkillPrompt`, and `append` and `dispatchAfterTurn` with
  `AgentEvent`; `executeSynthetic` is required.

### What stays

- #1440 had a reduced scope, by the owner's decision. `LoopExtensions` stays
  in `agent-loop.ts`, because the borrowed-runtime branch of the session passes
  it an object literal, not an `ExtensionRuntime`. `EventDispatcher` stays in
  `session/event-log.ts`, because the tests of `event-log` implement it.
  `LoopBeforeTurn` and `LoopModelRetry` stay as parameter objects, as the
  #1440 brief foresaw. The collaborators were not otherwise reshaped.
- The `session/` layout in Consequences is as it was: `agent-loop.ts`,
  `event-log.ts`, `permission-gate.ts`, `tool-runner.ts` and `turn-queue.ts`
  are still the collaborator files.
- "No new public exports": no collaborator or `SessionPort` is exported from
  `packages/core/src/index.ts`. The sentence does not cover `bindSession`:
  `ExtensionRuntime` is exported from `@moh/core` (it is not a session
  collaborator), and its public methods and constructor options changed — five
  setters removed, `bindSession` added, `requestTurn` and `isPathDenied`
  removed from the options. #1596 records that change as authorized by the
  owner.
  `SessionConfig`, the parameter type of `createSession`, also changed one
  field, its name and its type, as described above.

### References

- #1438 and PR #1596 (merge commit `3750b183`); #1439 and PR #1600 (merge
  commit `825d0b2d`); #1440 and PR #1601 (merge commit `2b233e49`).
- #1597, #1598: behaviors of the runtime binding that predate #1596 and were
  left unchanged. #1599: the shape of the `listModels` result returned by the
  session's model seam, which predates #1596 and surfaced when #1596 removed a
  cast; left unchanged.
