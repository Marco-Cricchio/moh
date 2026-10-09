# ADR-0076: Composer bang commands — user-invoked bash from the chat composer

Status: accepted · Date: 2026-10-09
Related: ADR-0004 (public-surface criterion), ADR-0031 (permission posture: restrict-only, reduced prompts), ADR-0067 (tool seam through the one ToolRunner), principles 3–4 (one door per capability, user data)

## Context

Users sometimes want to run a shell command directly from the chat composer —
quick `git status`, a one-off script — without phrasing it as a prompt and
waiting for the agent to decide to run bash. Two designs were rejected:

- **A second shell channel** (a raw PTY beside the session): it duplicates the
  bash tool's permission grammar, pathScopes, timeouts and output handling
  behind a second door that bypasses everything ADR-0031 built.
- **Sending `!cmd` as a prompt** and instructing the model to run it: the
  latency and the non-determinism are exactly what the user is escaping.

## Decision

**`!cmd` in the chat composer routes through the existing bash tool — no
second shell, no core loop change.**

- **Trigger**: `!cmd` in the **chat composer only** (Home's composer leaves
  `!` as plain text). Escape for a literal leading `!`: `\!` (the backslash
  is consumed on send).
- **Forms**:
  - `!cmd` — execute only; the output renders in chat and enters the event
    log as a regular tool result (the agent sees it next turn if relevant).
  - `!!cmd` — execute **and** auto-send the (tool-truncated) output to the
    model when the command finishes; no second confirm.
- **Active turn**: both forms are refused visibly while a stream runs (the
  refusal names the escape hatches: esc to interrupt / wait). `!!` is *not*
  steering.
- **Permissions**: a real bash tool call — same rule grammar, same extension
  veto, same pathScopes (if bash is denied, `!` is denied). The consent
  prompt is reduced to **y/n only**, rendered in the existing permission
  modal; no edit, no always — owner-accepted friction for a command the user
  typed themselves. Mode lifting stays uniform with the agent path: yolo and
  auto-accept both skip the prompt. The reduced prompt rides the existing
  `PermissionAskContext` seam with a new `source: "user"` variant (the
  client-side twin of ADR-0031's extension-ask reduction).
- **Timeout**: 120s fixed for the `!` path, independent of the bash tool's
  own timeout configuration; tool-standard output truncation and long-output
  handling apply unchanged.
- **Public surface** (ADR-0004 criterion): one new `AgentSession.runBash`
  method — the core-level door clients call; everything else is TUI-owned
  parsing and rendering.

## Consequences

- The event log holds a genuine `tool_call`/`tool_result` pair per `!`
  command: resume, fork and replay see exactly what happened, and the secret
  redaction pass applies at the same write seam as every other event.
- No new permission tier, no new grammar for the permission resolver, no
  extension API change — an extension's bash veto or ask applies to `!`
  commands with zero awareness of them.
- The user's own command is the user's own consent surface: moh does not
  record an "always" rule from it, so the reduced prompt cannot be gamed
  into pre-authorizing later model-initiated calls.
