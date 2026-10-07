# ADR-0074: Agent teams — the first-party team extension

Status: accepted · Date: 2026-10-06
Related: ADR-0031 (restrict-only), ADR-0053 (spawn-subagent capability), ADR-0055 (orchestration capability), ADR-0060 (lanes), ADR-0062 (panel UI), ADR-0037 (`requestTurn`)
Reference: `docs/vision/agent-teams-comparison.md`; layout prototypes `prototype/rail-right-multi.tsx` (adopted), `prototype/rail-multi-extension.tsx` (rejected), `prototype/team-view-rail.tsx`.

## Context

The Claude Code agent-teams comparison (`docs/vision/agent-teams-comparison.md`) left the
agent-teams question open: moh has the safety substrate (envelope intersected per spawn,
restrict-only, lanes) but no team experience, and the peer-to-peer mailbox model was
rejected as an injection surface that breaks the star. The discussion settled on a
first-party **team extension** acting as the team's project leader, with native `spawn`
remaining for the simple single-subagent ask. The rail layout question was settled
separately by prototypes and the owner's revision: right-side rail, one bordered panel
per extension, dynamic vertical distribution, composer floor (grilling issue #1218 owns
the rail deltas against `ExtensionsRail.tsx`).

Today's spawn behavior, verified in code: `spawn` defaults to `"ask"` (`permissions.ts`),
and yolo/auto-accept lift the prompt (`permission-gate.ts` L106/L112) — so in those modes
the model already spawns children freely, with the parent's full permissions and no
per-role structure. Plain spawn has no envelope, no task coordination, and no team-scoped
stop: the team extension is the first mechanism that adds structure there, not an extra
layer of authority.

## Decision

**The hybrid.** Native `spawn` stays what it is — the tool for the simple, single-subagent
ask, including its consent posture (`"ask"` in normal mode, lifted by yolo/auto-accept as
today). Team orchestration — roles, lanes, shared work, team-scoped stop — belongs to a
**first-party team extension** built on the ADR-0055 orchestration capability
(`spawn-subagent` + envelope + write-into-child + stop-all).

**Composition is the extension's judgment, driven by task complexity.** The criterion for
"team or not" is the task's complexity, not the subagent count: a low-complexity task may
resolve to a single member, a complex one to a multi-role team. The extension decides the
composition — which roles, how many members, in which lanes, in what order — and the
native spawn path stays available for the plain one-subagent ask that needs none of it.

**Team ceiling: 10 concurrent children.** The envelope the enable consent grants caps the
team at 10 concurrent subagents. Native `spawn` concurrency is raised independently:
`DEFAULT_SUBAGENT_CONCURRENCY` 3 → 5 (still configurable via `subagents.maxConcurrency`).

**Coordination: the task bag, star-shaped.** The extension owns a shared task list its
members claim (the coordination seam from the comparison notes); members never message
each other — all steering flows through the extension via write-into-child (ADR-0055).
Every claim, completion and the team-scoped stop-all land in the event log as chrome
events, so the session reconstructs what happened.

**Surface: one panel in the right rail.** Per the settled layout (and grilling issue
#1218 for the rail deltas), the team extension contributes one panel: the roster with
live state, member selection, in-panel detail view, and the stop-all. Members also
surface in the SubagentChipRow through the existing subagent tracking — no new chrome.

**Roles carry scopes, not new authority.** A role (builder, reviewer, …) is an envelope
preset: path scopes, tool restrictions and provider/model choice per member. Reviewer
roles are read-only by scope. The extension can only restrict — ADR-0031 is untouched.

## Non-goals

- Peer-to-peer messaging between team members (injection surface; star-shaped steering
  covers the use cases).
- Split-pane / multi-terminal display modes.
- Nested teams (children never spawn — unchanged).
- Extending the native `spawn` tool with team features (the extension is the team path).

## Consequences

- The team experience requires enabling the extension once (enable consent names the
  envelope: spawn cap, scopes, stop-all); in yolo the consent is formally moot but the
  structure (scopes, cap, log) still applies.
- The coordination seam (task bag) is new core-adjacent state owned by the extension —
  its events ride the session log (principle 2) and its storage is extension-owned, not a
  new core subsystem.
- The rail work tracked in #1218 is the surface dependency: the team panel assumes
  per-extension bordered panels and the dynamic distribution.
- Native spawn behavior changes only in the concurrency default (3 → 5); everything else
  about `spawn` is untouched.
- The ADR-0055 orchestration capability gains its first first-party consumer; anything
  the extension needs that ADR-0055 does not grant is a visible widening of that ADR,
  not a silent one.
