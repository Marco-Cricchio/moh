# moh — CONTEXT

## Glossary

- **Core** — the headless library (`@moh/core`) that runs the agent loop. No UI, no global state.
- **Client** — a consumer of the Core in-process: the TUI or the CLI. Never talks to providers directly.
- **AgentSession** — one conversation instance inside the Core. Multi-instance by design; subagents are child sessions.
- **Event log** — the append-only sequence of AgentEvents that *is* the session: source of streaming, persistence, and replay.
- **AgentEvent** — a single entry in the event log (`session_start`, `user_message`, `assistant_delta`, `tool_call`, `tool_result`, `model_call`, `done`, `error`, `cancelled`, plus chrome like `permission_*`/`mcp_*`/`memory_updated`). `model_call` (#83) records which model served one provider call and its token usage; `done` carries the turn's usage totals and `models` rollup.
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
- **Session file** — the persisted session: one append-only JSONL event log per session at `~/.moh/projects/<project-slug>/<id>.jsonl` (id = sortable timestamp + short uuid). Sessions are user data; they never live in the project's `.moh/`.
- **Resume / Fork** — the two ways a session continues: **resume** appends to the same file (default), **fork** starts a new file inheriting the history.
- **Memory** — durable facts kept **across** sessions, per project, at `~/.moh/projects/<slug>/memory/` (index + append-only topic files, dated and session-signed). Written automatically post-turn; never merged by the core — only appended atomically and consolidated by the maintenance subagent.
- **Compaction** — rebuilding the past **within** a session: an in-log `compaction` marker (summary + pointers) that replay uses instead of replaying everything. The log stays integral forever; nothing is ever deleted. Distinct from Memory — no fact is stored in both.
- **Maintenance subagent** — the background agent that extracts memory updates and compacts context; invisible to the TUI (a successful extraction surfaces only as a discreet `memory_updated` event/indicator), fail-silent, privileged: it is the only writer allowed to consolidate (newest-wins rewrite with a dated note) and is never reachable through the `spawn` tool.
- **Workflow upstream** — the official Matt Pocock skill repository, polled (opt-out) at startup when workflow mode is on, as the live update channel for first-party skills.
- **MCP server** — an external tool source declared in moh.json (project, consent required on first use) or `~/.moh/config` (user, trusted). Stdio or HTTP transport; started lazily on first use, stopped at session end.
- **PromptComposer** — the Core component that assembles the system prompt for every model call from typed sections in fixed order (base, environment, tools, skills, memory, session-state). Clients never touch the prompt; extensions can read it via `beforeModelCall` and append to the trailing `extension_notes` section, never rewrite.
- **Base prompt** — the shipped identity/behavior section (English, "reply in the user's language"), overridable in full by a `prompts/system.md` file (`~/.moh` < `.moh`, project wins).
- **MCP tool** — a tool exposed by an MCP server, registered as `mcp__<server>__<tool>` under the same Tool contract and permission spine as built-ins, with a stricter default: ask on first invocation.
- **Subagent** — an in-process child AgentSession spawned via the `spawn` tool from a `SubagentSpec` (inline or a preset: built-in `research`/`implement`, overridable in moh.json `agents`). Strict-subset tool inheritance (MCP tools never inherited), depth 1, own JSONL log, own per-turn loop cap, parallel spawns capped (default 3); child failure surfaces as an error result and never fails the parent's turn.

### Internal collaborators (ADR-0003)

- **MemoryRunner** (`memory.ts`, #88) — the post-turn memory trigger inside `AgentSession`: counts completed turns, windows the transcript, runs the extractor with one retry, fail-silent but not lossy (a failed run keeps its turns eligible for the next trigger). Emits a single `memory_updated` event on success; `createMaintenanceExtractor` (the default extractor's maintenance subagent) lives beside it in `memory.ts`.
- EventLog / TurnQueue / AgentLoop / ToolRunner / PermissionGate — planned collaborators of the session decomposition (#89–#92); names land in this glossary as each ticket merges.
