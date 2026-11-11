# Contributing to moh

Thanks for contributing! This file covers the human-facing basics; agent-facing
conventions live in `AGENTS.md` (scaffolded per-project with `moh init`) — when
the two overlap, `AGENTS.md` wins.

## License

Original moh code and documentation are licensed under the GNU Affero General
Public License, version 3 or any later version (AGPL-3.0-or-later). We intend
contributions to be made available under those terms, while contributors retain
copyright in their contributions. Before contributing, please contact the
maintainers if the applicable licensing terms or permission for your
contribution are unclear; the project has not adopted a DCO or CLA process.
Third-party dependencies and bundled materials remain under their respective
licenses; see their notices and license files.

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
- Principle 8, *lean by default*: a change adds only what a caller in the same change uses — no export, option or abstraction without one — and deletes what it leaves unused.
  Mechanical checks enforce it; a change that fails one needs an allowlist entry with a reason.
  Read it in [docs/principles.md](docs/principles.md) and [ADR-0078](docs/adr/0078-lean-by-default.md).
- Domain vocabulary lives in a project-local `CONTEXT.md` (glossary-only, kept current) — scaffolded by `moh init`; this repo keeps its own copy out of version control.
- Hard-to-reverse decisions get an ADR in `docs/adr/`.
- Code comments and docs in English; keep them explaining *why*, not *what*.
- Keep internal working artifacts out of version control. Use the ignored `research/`, `research-*/`, or `prototype/` directories for investigation notes and throwaway work; never force-add them. Publish durable findings in issues or maintained documentation instead.
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
   Generation failures leave the published catalog unchanged. All catalog
   commands serialize with an owner lock and recover interrupted publication
   before reading files; rerun the command after a terminated generator.
   If lock reclamation itself was interrupted, the error names the `.reclaim`
   marker: verify its recorded owner has exited before removing that marker.
   Do not run a build while a catalog generation is publishing its directory.
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

Catalog PRs run `--check --baseline <PR-base-SHA>`: the check uses the
committed, compressed source snapshots and their hashes, never live endpoints.
It reproduces catalog bytes, manifest provenance, and the generation report;
it also compares semantic changes against the PR base, independently of the
baseline saved with the generation. `--check` alone is the same offline
reproducibility check without that additional Git comparison. The release's
version gate runs it too.

Generation captures the exact source bytes and acquisition times in
`model-catalogs/sources/`, alongside a content-addressed copy of the previous
catalog used for the report. Commit the snapshot files with the generated
catalog. Old snapshots are removed from the current directory on the next
successful generation and remain available through Git history. Local input
files (`--models-dev` / `--open-router`) are explicitly marked as file inputs;
their acquisition time means when the pipeline read them, not an invented
upstream publication date.

Between releases, the daily `model-catalogs-check` monitor runs `--freshness`
against live sources. Its summary and `catalog-source-review` artifact report
changes, guard failures, candidate models, and retired listings that have
reappeared. A source outage fails the measurement; ordinary upstream changes
are review work, not a failure of a reproducible PR. No scheduled job commits
changes or retires models. For the same report locally:

```sh
bun packages/core/scripts/build-model-catalogs.ts --freshness --report /tmp/catalog-review.json
```

A reduction is approved with `acceptContextShrink: { "from": 204800, "to":
200000 }`, plus the sidecar's author/date/reason. That approval cannot accept a
different transition. For a newly retired row, include `retirementEvidence`
with a source URL and explain the provider/listing evidence in `reason`.
Missing aggregator data alone is insufficient: retain the last valid
catalog while investigating. Historical retired declarations remain
recorded, and a reappearing listing is reported for review rather than silently
restored. New source listings are candidates only; compatibility and thinking
maps still require moh-owned declarations.

## Extending moh

Writing an extension or a skill? See [docs/extending/](docs/extending/index.md).
