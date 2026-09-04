<div align="center">

# moh

**Your terminal, with a coding agent inside.**

[![Release](https://img.shields.io/github/v/release/Marco-Cricchio/moh?display_name=tag&sort=semver&label=version&color=blue)](https://github.com/Marco-Cricchio/moh/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

*Open source · MIT licensed · Runs on macOS and Linux · No Node, no Bun, no npm required*

</div>

---

## What is moh?

moh is a coding agent that lives in your terminal: you describe what you want
in plain language, and moh reads your code, edits files, runs commands, and
gets the work done — showing you every step and asking permission before
anything risky.

Three things make it different:

- **It works with the AI provider you choose.** Anthropic, OpenAI, Google,
  GitHub Copilot, OpenRouter, Kimi, xAI — and local models too (Ollama, LM
  Studio), all through one configuration. If a provider goes down, moh falls
  back to the next one on your list. Your agent setup is never locked to a
  single vendor.
- **Your data stays yours.** Sessions, memory, and notes live in a plain
  append-only log on your machine (`~/.moh/`) — nothing is ever deleted, and
  you can resume, fork, or compact any session at any time.
- **It asks before it acts.** A layered permission system gates every file
  write and every shell command; extensions can veto actions but can never
  grant more than you allowed.

## Highlights

- **Terminal UI (TUI)** — a fast, keyboard-driven interface with file
  mentions (`@path`), image previews, session picker, and guided provider
  onboarding. Or go headless with `moh run` for scripts and CI — no prompts,
  fail-fast.
- **Workflow mode** — an optional first-party port of the Matt Pocock agent
  workflow (wayfinder, grilling, to-spec, to-tickets, tdd, code-review, …)
  plus declarative GitHub repo management (`gh-manager`). One command to
  turn it on: `/workflow on`.
- **Skills** — progressive-disclosure capabilities you can author yourself;
  bundled ones are user-owned and only upgraded when you haven't modified
  them.
- **Memory** — durable, per-project facts kept across sessions, written
  automatically after each turn and consolidated in the background.
- **Subagents & MCP** — in-process subagents with strict tool inheritance,
  and Model Context Protocol servers configured lazily per project.
- **Always up to date** — moh quietly checks for new releases and skill
  updates while you work (never installing anything without your explicit
  consent; fully disableable).

## Install

Requirements: none — the binary is self-contained (Bun runtime embedded);
no Node, no Bun, no npm.

One command, from the latest GitHub Release (macOS arm64/x64, Linux x64):

```sh
curl -fsSL https://raw.githubusercontent.com/Marco-Cricchio/moh/develop/scripts/install.sh | sh
```

The script detects your platform, downloads the self-contained binary,
verifies its sha256 against `checksums.txt`, and installs it to
`~/.local/bin` (upgrade-over-itself on re-run). If that directory is not on
your `PATH`, the script prints the line to add. Set `MOH_INSTALL_DIR` to
install elsewhere.

On macOS (or Linux) with Homebrew:

```sh
brew install Marco-Cricchio/moh/moh
```

The tap formula ([Marco-Cricchio/homebrew-moh](https://github.com/Marco-Cricchio/homebrew-moh))
installs the same checksummed release binary and is updated automatically
after each published release.

## Use moh

Run the TUI client and complete guided provider onboarding:

```sh
moh
```

Headless, scripted sessions never prompt — unpermitted tools fail fast:

```sh
moh run --allow bash
```

Scaffold agent docs for your repo (AGENTS.md + `docs/agents/` tracker layout):

```sh
moh init
```

## How it's built

moh is a monorepo of four packages built around one rule: **all agent logic
lives in the headless core; every client is thin.**

| Package | What it is |
| --- | --- |
| `@moh/core` | The agent loop, append-only event log, providers, permissions, skills, memory, subagents, extensions. No UI, no global state. |
| `@moh/tui` | The Ink terminal client. Never talks to providers directly. |
| `@moh/cli` | `moh` binary: interactive entry, `moh run` (headless, fail-fast), `moh init`. |
| `@moh/extension` | Types-only contract for extensions. |

## Hack on moh

The repo builds and tests with Bun:

```sh
bun install
bun test          # 378 tests
bun run typecheck
```

Before changing anything, read `docs/principles.md` — the seven principles
govern every change, and a change that violates one needs an explicit ADR
saying why. Decisions are recorded, not implied: see `docs/adr/`.

## Documentation

- `docs/extending/` — extending moh: writing extensions, embedding the
  core as a library, authoring skills
- `docs/provider-reasoning.md` — provider reasoning privacy, persistence,
  display controls, and thinking-level availability
- `docs/principles.md` — the seven principles governing every change
- `docs/adr/` — architecture decision records
- `CONTRIBUTING.md` — conventions for contributors and forkers

## Acknowledgements & disclaimer

moh is an independent project, **not affiliated with or endorsed by** Matt
Pocock or the authors of Pi. It was created drawing inspiration from:

- the **architectural principles of pi** (Mario Zechner's
  coding agent harness) — headless core, thin clients,
  skills and progressive disclosure, subagents; and
- the **Matt Pocock's agent workflow** — the wayfinder/grilling/to-spec/to-tickets
  cycle, ported as first-party skills under the terms of the upstream MIT
  license (see `packages/core/assets/skills/NOTICE.md`); and
- **David Lawson's gh-manager** ([@ddlaws0n](https://github.com/ddlaws0n),
  https://github.com/ddlaws0n/gh-manager) — whose declarative
  `init → plan → apply` repository-management approach is ported as the
  first-party `gh-manager` skill under the terms of its MIT license.

## License

MIT — see [LICENSE](LICENSE).
