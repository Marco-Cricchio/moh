# Spec: moh as a single compiled binary (public distribution)

Status: agreed · Origin: grilling session on packaging (2025) · Related: ADR-0013 (decision record), `docs/principles.md`, `docs/agents/issue-tracker.md`

## Problem

moh is started with `bun packages/cli/src/cli.ts` inside the repo. For public distribution the user must install once and type `moh`. Today there is no build, no release pipeline, and no install path; the code also assumes it runs from a repo checkout (skills bundle read from the package directory on disk).

## Decisions (from grilling)

1. **Distribution channel: a self-contained binary** built with `bun build --compile`. The Bun runtime ships inside the executable; the user needs no Node, no Bun, no `npm i -g`. An npm package is explicitly *not* in scope — the production code uses Bun runtime APIs (`Bun.spawn`, `Bun.file`, `Bun.Glob`, `Bun.CryptoHasher`, …) in ~8 core modules and porting them to Node is a separate future decision.
2. **Primary source: GitHub Releases** for tag `v*`, with a `curl -fsSL … | sh` install script (download, checksum verify, PATH setup, upgrade-over-itself). A Homebrew tap follows as a second step pointing at the same releases.
3. **Platforms for 0.1.0:** macOS arm64, macOS x64, Linux x64. Windows deferred — the raw-terminal TUI is the risk area there and is out of scope.
4. **Version:** first public release is `0.1.0`, stamped into the binary at build time and surfaced by `moh --version`.
5. **First-party skills:** bundled as embedded assets in the binary and copied lazily on first run into `~/.moh/skills/` via the existing hash-manifest mechanism (`workflow.ts`, injectable `bundleDir`). No postinstall step exists or is needed; "zero friction at install" is delivered by first-run lazy copy. Unmodified skills upgrade in place; modified ones are left alone (existing behavior, unchanged).
6. **CI:** GitHub Actions workflow triggered by `v*` tags — build the three targets, smoke-test each binary (`moh --version`, plus a headless smoke), attach with checksums to the GitHub Release.

## Invariants

1. `bun packages/cli/src/cli.ts` keeps working from a checkout (developer path unchanged).
2. The binary contains no repo-relative filesystem assumptions: everything it reads is either embedded, in `~/.moh/`, or in the user's project.
3. Session data, auth store, and user config locations are identical between dev-run and binary-run (`~/.moh/…`).
4. Release binaries are reproducible from CI only; no manual binary is ever published.

## Work breakdown (feeds /to-tickets)

1. **Build entrypoint** — `scripts/build.ts`: compile the CLI for the three targets, embed the skills bundle, stamp version. Everything else depends on this.
2. **Binary-path awareness** — the skills/workflow bundle resolution must find embedded assets when running as a compiled binary (the existing `bundleDir` seam).
3. **CI release pipeline** — tag-triggered workflow producing the GitHub Release with checksums.
4. **Install script** — `install.sh` served from the repo (download per-platform, verify, install to `~/.local/bin` or equivalent, PATH hint).
5. **Homebrew tap** — separate repo/tap with a formula pointing at the release.
6. **Docs** — README install section, `moh --help`/first-run experience sanity pass.
