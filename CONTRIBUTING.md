# Contributing to moh

Thanks for contributing! This file covers the human-facing basics; agent-facing
conventions live in `AGENTS.md` (scaffolded per-project with `moh init`) — when
the two overlap, `AGENTS.md` wins.

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
- Domain vocabulary lives in a project-local `CONTEXT.md` (glossary-only, kept current) — scaffolded by `moh init`; this repo keeps its own copy out of version control.
- Hard-to-reverse decisions get an ADR in `docs/adr/`.
- Code comments and docs in English; keep them explaining *why*, not *what*.
- Tests: targeted event-trace assertions, not snapshots. Use `MockProvider` (scripted turns / cassettes) and `EchoProvider` (context-engineering digest) — never real API calls in CI.
- **User manual (light alignment)**: `docs/manual/` is a generated mirror of the bundled manual assets — never edit those files directly (`bun packages/core/scripts/gen-manual-docs.ts` regenerates them). A PR that changes a user-visible door (keybinding, slash command, CLI flag, config key, wizard/screen copy) updates the affected manual page in the same PR. CI warns — never blocks — when surfaces change without the manual.

## PR flow

1. Branch from `develop` (the integration branch) and target `develop` in your PR. Never open a PR into `main`; `main` is updated only by promoting from `develop`.
2. Issues live in GitHub Issues; work is tracked against triaged tickets (`ready-for-agent` / `ready-for-human`).
3. Ensure `bun run typecheck` and `bun test` pass before requesting review.
4. Commit messages: conventional commits (`feat(core): ...`, `fix(cli): ...`, `docs: ...`).
5. Changelog: a PR that closes a user-facing ticket adds a bullet under `## [Unreleased]` in `CHANGELOG.md`. At tag time the release pipeline extracts the matching `## [x.y.z]` section as the GitHub Release body; a tag without its section fails CI.

## Releases

Releases are cut from `develop`: a release PR finalizes the changelog and the
model catalog, the integration branch is then promoted to `main` and tagged
`vX.Y.Z`, and pushing the tag runs `.github/workflows/release.yml` (platform
binaries, smoke tests, and a draft GitHub Release that the owner publishes).
The order matters:

1. **Propose the version** — patch, minor or major from the unreleased
   changelog, confirmed by the owner — and cut `release/vX.Y.Z` from `develop`.
   Do steps 2 and 3 on that branch, in the same release PR.
2. **Finalize the changelog**: move the `## [Unreleased]` entries into a dated
   `## [X.Y.Z]` section. The tag-time pipeline extracts that section as the
   Release body and fails without it.
3. **Regenerate the model catalog declaring that version**:
   `bun packages/core/scripts/build-model-catalogs.ts --version X.Y.Z`, review
   the data diff in `packages/core/src/model-catalogs/generation-report.json`,
   and commit the catalog files. This is the only moment the catalog is written
   in a release cycle — no pipeline regenerates it (ADR-0046) — and the release
   PR is where a human reviews the prices the release ships.
4. **Open the release PR to `develop`**, wait for green, merge.
5. **Promote `develop` to `main`** (the production branch) at the merged commit.
6. **Tag `vX.Y.Z`** there and push the tag.
7. **Watch the tag run**: `build` (binaries + native smoke tests),
   `catalog-check` (reports the shipped catalog's age and how far upstream has
   moved — no flavour of drift fails it, not even a rebuild its guards reject)
   and `version-check` (fails if `manifest.json` declares a version other than
   the tag). The version check gates the draft Release, because
   `PRICING_SNAPSHOT.version` is a public export read from that manifest: a
   release must not ship a manifest naming another release — v0.50.1 did. This
   is also why step 3 is not optional.
8. **Verify the draft Release** — assets, checksums, notes matching the
   finalized changelog — and publish it.

Between releases, the daily `model-catalogs-check` workflow is where catalog
drift turns red; a red there means an upstream change is due to be regenerated
(or a catalog was hand-edited instead of going through its sidecar), not that a
release is blocked.

## Extending moh

Writing an extension or a skill? See [docs/extending/](docs/extending/index.md).
