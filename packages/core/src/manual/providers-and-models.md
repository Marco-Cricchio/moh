# Providers & models

A **provider** is a backend that talks to LLMs; a **model** is what you
pick within it. moh ships built-ins for anthropic, openai, google,
github-copilot, openrouter, kimi-coding and xai, plus a zero-credential
**mock** provider (the default) and custom endpoints via `openai-compat`.

## Adding a provider

```
moh provider add
```

The wizard first asks **API key or subscription**. A subscription login
(Claude Pro/Max, ChatGPT Plus/Pro, personal Google) runs the provider's
OAuth flow and stores its tokens in `~/.moh/config` — never in
moh.json, never in logs. `moh provider login <name>` re-establishes
tokens, `moh provider logout <name>` drops them, `moh provider status`
shows per-endpoint auth state and plan usage.

## Endpoints and routing

Each configured endpoint is an entry in moh.json (or `~/.moh/config`):
name, type, optional base URL, credentials, default model, optional
fallback models. A model reference is `endpoint/model-id`; the current
one is shown in the status bar.

## Switching models

- `/model` in the TUI opens the picker: every configured endpoint's
  list (from the vendored catalog, or `GET /models` for openai-compat
  endpoints). The switch takes effect from the next turn.
- `moh run --provider <endpoint/model-id>` picks the model per run.
- The Settings panel's endpoint → model picker saves the default into
  moh.json (user-level endpoints are display-only there).

## Thinking levels

Thinking-capable models accept a reasoning-effort level: `off`, `low`,
`medium`, `high`, `xhigh`, `max`. Cycle it with `ctrl+y` or set it in
`/thinking`. The levels a model actually supports come from the vendored
catalog (or an explicit `capabilities.thinking` declaration for
openai-compat endpoints); unsupported levels are shown as unavailable
rather than silently remapped. The effective level sent is recorded in
the session log.
