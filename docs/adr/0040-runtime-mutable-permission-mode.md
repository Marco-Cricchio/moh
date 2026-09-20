# ADR-0040: the permission mode is runtime-mutable, never persisted

Status: accepted · Date: 2026-09-20 · Parent: issue #849

## Context

The permission mode (`normal` / `auto-accept` / `yolo`) was frozen at session
construction: `PermissionResolver` received it once and exposed it read-only,
the filesystem-scope closure captured the value at build time, and `yolo` was
documented as launch-only (`--yolo`), never settable in-session. A yolo session
had no way back except relaunching moh — the owner's actual report.

Making the mode mutable in-session changes two documented contracts:

1. **`--yolo` as launch-only** (#377, manual + CLI help): the flag remains the
   *launch-time* opt-in, but yolo is no longer exclusively launch-reachable.
2. **The filesystem-scope promise** (SEC-03/#377): project-root containment is
   now something a session can shed and re-arm mid-flight.

## Decision

**Go — the mode is the session's live state, the log is its record, and no
configuration is ever written.**

- `AgentSession.setSessionMode(mode)` is the single setter: it updates the
  resolver and appends one `session_mode` chrome event per change. It is a
  no-op when the mode is already in force.
- Every consumer reads the mode at decision time, never a build-time copy:
  the permission gate resolves `mode` per tool call, the tool runner's
  `filesystemScope` is a lazy accessor, and subagents inherit the parent's
  *live* mode at spawn time (never more permissive than the session they
  came from).
- The TUI's `shift+tab` rotates `normal → auto-accept → yolo → normal`,
  effective from the very next tool decision. The `⚠ YOLO` banner renders
  from the live mode, not the launch flag.
- **Never persisted**: the rotation writes nothing to any configuration file.
  A new session starts from its configuration again; `--yolo` remains the
  launch-time default for that process only.
- Replay fidelity comes free: `session_mode` was already chrome, already
  appended at start and on resume mismatch, and the Jev guardrail already
  tracked it — so a mid-session rotation is auditable and consumers follow
  without any new seam.

## Alternatives considered

- **`normal ↔ auto-accept` only, yolo stays launch-only** — rejected: the
  report's core scenario is "I am stuck in yolo"; a rotation that cannot
  leave yolo does not fix it.
- **Client-local flag (TUI state only)** — rejected: the permission gate and
  the filesystem scope live in the core; a client flag would either lie or
  need a new core setter anyway, and a resumed session could not replay
  which mode was in force when a tool call was decided.
- **Confirmation modal before entering yolo** — rejected for now (owner
  scoping): the rotation is one deliberate keypress in a session the user
  owns, the banner is unmissable, and leaving is the same keypress.

## Consequences

- A session that leaves yolo regains project-root containment and prompts
  immediately — asserted in tests, not assumed.
- The Settings panel's `permissionMode` row keeps its name and meaning: it
  is the *default for new sessions*; the in-session rotation never touches
  it.
- Any future consumer of the mode must read the live value (resolver getter
  or `session_mode` events), never snapshot it at assembly.
