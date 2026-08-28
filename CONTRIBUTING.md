# Contributing to moh

Thanks for contributing! This file covers the human-facing basics; **agent-facing conventions live in [AGENTS.md](AGENTS.md)** — when the two overlap, AGENTS.md wins.

## Setup

- **Runtime**: TypeScript on [Bun](https://bun.sh) (no Node needed for development).
- **Install**: `bun install` at the repo root (bun workspaces).
- **Build/typecheck**: `bun run typecheck`
- **Tests**: `bun test` (single file: `bun test packages/core/test/session.test.ts`)

No API keys are required to develop or test: the mock and echo providers cover the loop, permissions, fallback chains, and context-engineering e2e (spec §11).

## Repo layout

- `packages/core` — `@moh/core`, the headless agent loop (no UI, no global state)
- `packages/cli` — headless CLI (`moh run`)
- `packages/tui` — Ink 6 terminal client
- `packages/extension` — types-only extension contract (`@moh/extension`)
- `docs/` — spec, ADRs, principles, extending guides

## Conventions

- Read [docs/principles.md](docs/principles.md) before any change; violations need an ADR.
- Domain vocabulary: [CONTEXT.md](CONTEXT.md) (glossary-only, kept current).
- Hard-to-reverse decisions get an ADR in `docs/adr/`.
- Code comments and docs in English; keep them explaining *why*, not *what*.
- Tests: targeted event-trace assertions, not snapshots. Use `MockProvider` (scripted turns / cassettes) and `EchoProvider` (context-engineering digest) — never real API calls in CI.

## PR flow

1. Branch from `develop` (the integration branch) and target `develop` in your PR. Never open a PR into `main`; `main` is updated only by promoting from `develop`.
2. Issues live in GitHub Issues; work is tracked against triaged tickets (`ready-for-agent` / `ready-for-human`).
3. Ensure `bun run typecheck` and `bun test` pass before requesting review.
4. Commit messages: conventional commits (`feat(core): ...`, `fix(cli): ...`, `docs: ...`).
5. Changelog: a PR that closes a user-facing ticket adds a bullet under `## [Unreleased]` in `CHANGELOG.md`. At tag time the release pipeline extracts the matching `## [x.y.z]` section as the GitHub Release body; a tag without its section fails CI.

## Extending moh

Writing an extension or a skill? See [docs/extending/](docs/extending/index.md).
