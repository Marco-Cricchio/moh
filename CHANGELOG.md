# Changelog

All notable changes to moh are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer. Each release's GitHub Release description is extracted from the
matching section here at tag time.

## [Unreleased]

## [0.4.0] - 2026-08-29

### Added

- bash tool, feedback loop against redundant suite re-runs (#304): successful
  runs of 10s+ save their full output to a file (pointer appended to the
  result) so the model can grep it instead of re-running with a different
  pipe; an identical suite-like re-run against an unchanged git tree within
  10 minutes is short-circuited with a pointer to the saved output. Guards
  protect every legitimate re-run (failures, cheap commands, non-suite
  commands, tree changes, no-git trees); `# fresh` forces a real run.

### Changed

- Add-provider wizard: the openai-compat Base URL step now offers a curated,
  selectable list of known API endpoints — locals first (Ollama, LM Studio,
  Omniroute), then cloud providers (z.ai, DeepSeek, Mistral, Groq, Together)
  and a `Custom…` free-text entry. The CLI shows it as a numbered prompt; the
  TUI adds a pick-list phase that prefills the still-editable base URL field
  (#295).

## [0.3.0] - 2026-08-29

### Added

- Live tool blocks show a running timer on the right of the block head:
  elapsed time and the command's effective timeout (`⏱ 12s · 30s`) while a
  tool runs — elapsed only for tools without a timeout — and the final
  duration (`✓ bash · 18s`) once the call settles. The effective timeout is
  stamped on the `tool_call` event by the core (`timeoutMs`, resolved by the
  tool itself, defaults included), so clients never duplicate per-tool
  defaults (#300).

## [0.2.1] - 2026-08-29

### Fixed

- Fixed: bash tool timeout/cancellation no longer leaks orphaned child
  processes on macOS (killed in the correct order; #297).

## [0.2.0] - 2026-08-28

### Changed

- Home screen polish: the terminal is cleared once at startup; a figlet-Slant
  "moh" banner with the "My Own Harness" acronym and the version number
  replaces the wordmark on tall terminals (one-line fallback elsewhere); the
  static hint line is gone and the footer now carries new (n), settings (s)
  and keys (?) (#292).

## [0.1.1] - 2026-08-28

### Fixed

- TUI: thinking separators are now rendered on a single line.
- TUI: no rainbow coloring of thinking separators at `xhigh` verbosity (#287).

## [0.1.0] - 2026-08-28

First public release: a provider-agnostic, headless-first coding agent as a
single self-contained binary (Bun runtime embedded — no Node, no npm).

### Added

- The platform as developed across the pre-release campaign: headless core
  (agent loop, append-only event log, providers, permissions, skills, memory,
  subagents, MCP) plus the Ink TUI, `moh run`, `moh init` and `moh provider`.

- Compiled-binary distribution for macOS arm64/x64 and Linux x64: one-command
  `curl | sh` installer with sha256 verification, CI release pipeline
  (tag-triggered builds + smoke tests), and a Homebrew tap.
- Update channel: daily GitHub `releases/latest` check (opt-out, no
  identifiers, silent on failure) with an in-TUI update notice and the
  `moh update` self-update command (download, checksum verify, atomic
  replace; downgrade-to-stable asks confirmation).
- First-party skills embedded in the binary, lazily copied to `~/.moh/skills/`
  on first run via the existing hash-manifest upgrade semantics.

[Unreleased]: https://github.com/Marco-Cricchio/moh/compare/v0.4.0...develop
[0.4.0]: https://github.com/Marco-Cricchio/moh/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Marco-Cricchio/moh/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Marco-Cricchio/moh/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Marco-Cricchio/moh/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Marco-Cricchio/moh/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Marco-Cricchio/moh/releases/tag/v0.1.0
