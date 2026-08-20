# moh — CONTEXT

## Glossary

- **Core** — the headless library (`@moh/core`) that runs the agent loop. No UI, no global state.
- **Client** — a consumer of the Core in-process: the TUI or the CLI. Never talks to providers directly.
- **AgentSession** — one conversation instance inside the Core. Multi-instance by design; subagents are child sessions.
- **Event log** — the append-only sequence of AgentEvents that *is* the session: source of streaming, persistence, and replay.
- **AgentEvent** — a single entry in the event log (`session_start`, `user_message`, `assistant_delta`, `tool_call`, `tool_result`, `error`, `done`, `cancelled`).
- **Turn** — one send→stream→tools→reply cycle of the agent loop. Loop protection and errors are scoped per turn, not per session.
- **Tool call / tool result** — a paired tool invocation and its outcome, correlated by `callId`.
- **Steering** — user input injected during an active stream: interrupts and re-sends.
- **Provider** — an implementation that talks to LLMs: built-in (anthropic, openai, google) or custom, registered via `registerProvider` or an `openai-compat` profile in moh.json. Single-shot: it never loops.
- **Endpoint** — a configured Provider instance with its own credentials (e.g. two Anthropic accounts = two endpoints).
- **Route** — a model reference `endpoint/model-id` with a declared fallback chain. The user declares the chain; moh assumes no model equivalence.
- **ProviderError** — a normalized error from a provider, one of 9 `kinds`: `auth`, `rate_limited`, `quota_exhausted`, `overloaded`, `network`, `invalid_request`, `context_length`, `content_filtered`, `aborted` (signal, not an error).
- **Phase hook** — the typed seam (e.g. `beforeModelCall`, `onToolCall`) through which extensions observe and influence the loop. Extensions can only restrict tool calls (veto), never grant.
- **Permission rule** — a matcher that allows/asks/denies a tool, optionally scoped by argument (shell-word tokens for `bash`, realpath-anchored path globs for edits/writes). One grammar shared by moh.json, TUI, and CLI.
- **Permission tiers** — most-specific-wins merge: built-in per-tool defaults < moh.json overrides < in-session runtime rules.
- **Permission veto** — an extension refusing a tool call via `onToolCall`; it overrides user rules and produces the same denied `tool_result`.
- **Out-of-root write** — a write outside the project root: authorizable per-occurrence only, asked again every time, never persists as a rule.
- **Workflow mode** — the per-user on/off state (persisted in `~/.moh/config`, toggled with `/workflow on|off`) that enables the first-party workflow: bundled skills, workflow commands, and the wayfinder frontier panel. When off, nothing about the agent's base behavior changes.
- **First-party skills** — the Matt Pocock workflow skills bundled in the moh package and copied to `~/.moh/skills/` at install/upgrade. User-owned: upgraded only when unmodified (hash check); modified ones are left alone with a diff offered.
- **Workflow upstream** — the official Matt Pocock skill repository, polled (opt-out) at startup when workflow mode is on, as the live update channel for first-party skills.
