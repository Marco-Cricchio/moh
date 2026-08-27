# Provider reasoning and thinking controls

moh can retain **provider reasoning**: reasoning text that a provider explicitly returns as part of a model call. This is not a promise of access to a model's private chain of thought. moh does not synthesize private reasoning, and models/providers that do not expose reasoning continue to work without it.

## Persistence and privacy

A completed provider call stores its reasoning and any opaque continuity metadata required by the provider (for example, a reasoning signature) in the session's append-only JSONL event log. The opaque metadata is sent back when reconstructing provider context but is never rendered as reasoning text.

This data:

- survives resume and fork;
- is included when a session file is exported, copied, or backed up;
- remains in the integral JSONL after compaction, although old reasoning may be replaced by the compaction summary in future provider prompts;
- is not checkpointed for a call interrupted before its provider message is finalized. Resume continues from the last completed call.

Treat session files as potentially sensitive user data. The TUI shows a one-shot, non-blocking notice before the first compatible call to disclose this persistence behavior.

## Display controls

Display and persistence are independent. Hiding reasoning changes only the TUI projection; it does not change provider requests, saved history, resume context, exports, or backups.

- Set the persistent global display default in **Settings → Provider reasoning**.
- Run `/thinking show` or `/thinking hide` for an immediate, session-only override. Showing it again also reveals historical completed reasoning loaded from the session log.
- Each call is rendered separately as `⋯ thinking · <model>`. Failed calls can retain a visible reasoning block.
- Display is capped at 64 KiB of sanitized UTF-8 text per call, with visible truncation. Persisted data is not truncated by this display cap.

## Thinking levels

Run `/thinking` to see the active model's available canonical levels. The canonical scale is:

`off`, `low`, `medium`, `high`, `xhigh`, `max`

Run `/thinking <level>` to persist the selection for the active endpoint. It applies from the next model call. A model switch resolves the newly active endpoint's preference, and every fallback stop resolves the serving endpoint's own preference. The effective level sent is recorded on each `model_call` event.

Level availability is model-specific. moh offers only levels declared by the active model's catalog map; unsupported entries are disabled and explained. moh never silently substitutes one level for another. If a model has no level map, level selection is unavailable and the provider default is used. Reasoning display can still work whenever that provider emits reasoning.
