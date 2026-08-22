# Spec: Decompose AgentSession into a session/ directory

Status: implemented (tickets #88–#92 merged) · Origin: codebase-health survey (opportunity #1) · Related: `docs/principles.md` (1, 2), ADR-0003 (written with ticket 1)

## Problem

`packages/core/src/session.ts` (787 lines) does seven jobs in one class: the append-only event log, the send queue/steering pump, the agent turn loop, tool execution, the permission gate (including moh.json persistence writes from inside the loop), the memory post-turn trigger (plus `createMaintenanceExtractor` at the bottom of the file), and all constructor wiring. The loop itself is healthy; the accumulated side-jobs break locality and make the file the codebase's gravity well.

## Goal

Restructure — not redesign. moh's observable behavior, event stream, and public API are unchanged.

## Target shape

```
packages/core/src/session/
  session.ts        — AgentSession: the single public entry; composes the
                      collaborators below; same public surface as today
  event-log.ts      — the append-only log: storage, sink, listeners,
                      extension event dispatch (serial queue, reentrancy guard)
  turn-queue.ts     — send queue + steering pump (preempt semantics unchanged)
  agent-loop.ts     — one turn: model calls, streaming, usage rollup (#83),
                      max-iterations cap
  tool-runner.ts    — same-turn parallel tool execution, result feedback
  permission-gate.ts— 3-tier gate: extension veto > rules > ask; owns the
                      "always" persistence decisions (runtime rule + moh.json)
memory.ts (existing)— gains the memory post-turn trigger and
                      createMaintenanceExtractor (moved from session.ts)
```

## Invariants (what must not change)

1. **Public API:** `AgentSession` remains the only visible class; every existing export from `@moh/core` keeps its name and behavior. No new public exports.
2. **Event stream:** same `AgentEvent`s in the same order for the same inputs, including `permission_*`, `model_call`, `memory_updated`, `extension_failed`.
3. **Semantics:** steering/preempt, per-turn loop cap, extension veto > user rules > defaults, fail-silent memory (one retry, non-lossy backoff), MCP lazy start / trusted-tool runtime rules — all byte-for-byte in behavior.
4. **"always" persistence** stays: runtime rule added + `mcp__*` tools persisted to moh.json — but the write moves into `permission-gate.ts`, out of the loop body.
5. **Tests:** all 340 pass. Only tests that import internal details may be touched, and only to update import paths (e.g. `createMaintenanceExtractor` now from `./memory.js`).

## Delivery

Five tracer-bullet tickets on GitHub Issues, risk-ascending order; each is a self-contained extraction ending with green tests, typecheck clean, one PR to `develop`:

1. **Memory** — move `createMaintenanceExtractor` + post-turn trigger into `memory.ts` (as `MemoryRunner` or equivalent).
2. **Event log** — extract `event-log.ts` (log, sink, listeners, extension dispatch queue).
3. **Permission gate** — extract `permission-gate.ts`, including the persistence decisions.
4. **Tool runner** — extract `tool-runner.ts` (parallel/sequential execution per capability).
5. **Loop + queue** — extract `agent-loop.ts` + `turn-queue.ts`; `session/` directory becomes the layout; `session.ts` is the thin director.

ADR-0003 (English) is written with ticket 1 and records the why; `CONTEXT.md` glossary gains the new internal names (EventLog, TurnQueue, AgentLoop, ToolRunner, PermissionGate) marked as internal collaborators of AgentSession.
