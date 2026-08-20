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
- **Phase hook** — the typed seam (e.g. `beforeModelCall`, `onToolCall`) through which extensions observe and influence the loop.
