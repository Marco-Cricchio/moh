# moh

A provider-agnostic, headless-first coding agent in TypeScript on Bun, with the
Matt Pocock workflow integrated natively as an optional mode.

moh is a monorepo of four packages built around one rule: **all agent logic
lives in the headless core; every client is thin.**

| Package | What it is |
| --- | --- |
| `@moh/core` | The agent loop, append-only event log, providers, permissions, skills, memory, subagents, extensions. No UI, no global state. |
| `@moh/tui` | The Ink terminal client. Never talks to providers directly. |
| `@moh/cli` | `moh` binary: interactive entry, `moh run` (headless, fail-fast), `moh init`. |
| `@moh/extension` | Types-only contract for extensions. |

## Highlights

- **The event log is the session.** One append-only JSONL sequence of
  `AgentEvent`s per session; streaming, persistence, resume, fork, compaction
  and the TUI are all projections of it. Nothing is ever deleted.
- **Providers are single-shot and provider-neutral.** moh owns the loop,
  retries and fallback across declared route chains. Built-in anthropic, openai
  and google adapters, config-only `openai-compat` profiles (Ollama, LM Studio,
  DeepSeek, OpenRouter, …) and programmatic `registerProvider`.
- **3-tier permission spine** (defaults < `moh.json` < runtime rules) that only
  narrows; extensions can veto tool calls but never widen permissions.
- **Workflow mode** (`/workflow on|off`): bundles faithful ports of the Matt
  Pocock skill set (wayfinder, grilling, to-spec, to-tickets, tdd, code-review,
  …) as user-owned first-party skills with an upstream update channel, plus
  the `ask_user` tool for accompanied questions with recommended answers.
- **Skills, subagents, memory, MCP.** Progressive-disclosure skills, in-process
  subagents with strict tool inheritance, cross-session per-project memory
  consolidated by a maintenance subagent, lazy MCP servers.

## Getting started

```sh
bun install
bun test          # 340 tests
bun run typecheck
```

Run the TUI client and complete guided provider onboarding:

```sh
bun packages/cli/src/cli.ts
```

Headless, scripted sessions never prompt — unpermitted tools fail fast:

```sh
moh run --allow bash
```

Scaffold agent docs for your repo (AGENTS.md + `docs/agents/` tracker layout):

```sh
moh init
```

## Documentation

- `docs/extending/` — extending moh: writing extensions, embedding the
  core as a library, authoring skills
- `docs/spec/v1.md` — the consolidated v1 specification
- `docs/principles.md` — the seven principles governing every change
- `CONTEXT.md` — glossary of the domain model
- `docs/adr/` — architecture decision records
- `CONTRIBUTING.md` — conventions for contributors and forkers

## Acknowledgements & disclaimer

moh is an independent project, **not affiliated with or endorsed by** Matt
Pocock or the authors of Pi. It was created drawing inspiration from:

- the **architectural principles of pi** (Mario Zechner's
  coding agent harness) — headless core, thin clients,
  skills and progressive disclosure, subagents; and
- **Matt Pocock's agent workflow** — the wayfinder/grilling/to-spec/to-tickets
  cycle, ported as first-party skills under the terms of the upstream MIT
  license (see `packages/core/assets/skills/NOTICE.md`).

## License

MIT — see [LICENSE](LICENSE).
