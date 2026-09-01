# Changelog

All notable changes to moh are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer. Each release's GitHub Release description is extracted from the
matching section here at tag time.

## [Unreleased]

### Added

- legacy ask_user replay compatibility (#415): sessions recorded with the
  pre-redesign single-question ask_user shape replay through the same
  compact Static projection as new question sets — translated in memory
  at projection time, with session JSONL files never rewritten.

- ask_user option previews, side-by-side (#414): questions whose options
  carry `preview` render an adjacent bordered box with the focused
  option's content — markdown with highlighted code blocks, truncating
  past the row budget with a hidden-lines indicator, favoring height
  when space is tight; the chosen option's preview is echoed back to the
  model in the tool result.
- ask_user inline block resize + compact Static projection (#413): while a
  question set is open the block grows with its content and compresses the
  volatile transcript; on resolution the settled block projects one row per
  question with the chosen answers, unchosen options omitted.

## [0.12.0] - 2026-09-01

### Added

- Session continuity across machines (#396): declared project identity
  persisted in `.moh/project.json` (slug + path hash) with automatic
  legacy migration, so resumed sessions find the same
  `~/.moh/projects/<slug>/` home on a different machine or path (#398).
- Session continuity portability contract: documented rules for syncing
  sessions across machines, including the serial single-writer contract
  and the ignore-list for what must not be synced (#397).
- Content-based memory lock (pid + boot/machine id): memory writes are
  owned by one machine at a time; a stale or foreign lock is detected
  from system identity rather than wall-clock heuristics (#399).
- Single-writer warning: an open session probes its file size at every
  append boundary and emits a `session_file_growth` chrome event when
  the file grows from elsewhere (another machine or process), surfaced
  as a visible warning in the TUI, CLI, and replay (#400).
- `moh run --resume [query]` headless session discovery: listing,
  best-match, id match, append, and cross-machine slug resolution;
  `--resume` now rejects `--fork` instead of silently ignoring it (#401).
- Cross-machine continuity acceptance tests end-to-end (shared home,
  two project roots) on the core, CLI, and TUI surfaces (#402).

### Fixed

- `session-memory` skill now computes the project slug with the core's exact rule (sanitized basename + path hash), so session notes land in the same `~/.moh/projects/<slug>/` directory as sessions and memory (#395).

## [0.11.2] - 2026-08-31

### Fixed

- YOLO sessions (`moh --yolo`) show the update-available notice again:
  the ⚠ YOLO status banner no longer occupies row 2's notice slot
  exclusively — the notice renders beside it, elided to the remaining
  budget (#377, #393).

## [0.11.1] - 2026-08-31

### Fixed

- `moh --yolo` (bare, no subcommand) now opens the TUI in yolo mode like
  `moh tui --yolo`; previously it failed with "unknown command". Stray
  arguments after the flag and `--yolo` on unrelated subcommands are
  explicit usage errors; `moh run --yolo` is unchanged (#377, #391).

## [0.11.0] - 2026-08-31

### Changed

- **Breaking**: replaced `--dangerously-bypass-permissions` with the
  launch-only `moh --yolo` / `moh tui --yolo` / `moh run --yolo` (#377).
  Yolo sessions run built-in tools with no permission prompts **and** no
  filesystem containment to the project root: `read`/`glob`/`grep`/
  `write`/`edit` may target any path — still resolved canonically
  (realpath, symlink-aware). The old flag is removed without an alias
  (the CLI rejects it pointing at `--yolo`). Extension vetoes still
  apply; MCP first-use consent is unchanged; normal mode is untouched.
  Internal renames: session mode `"bypass"` → `"yolo"`, config field
  `bypassPermissions` → `unrestrictedTools`. The TUI shows a persistent
  `⚠ YOLO` status indicator.

### Fixed

- First-party skills are now installed/synced at TUI launch for existing
  workflow users (binary upgrades included), not only on fresh installs (#385).
- A persisted `tool_result` is never replayed when its paired `tool_call`
  was discarded (e.g. by steering), preventing corrupted session resume (#371).

## [0.10.0] - 2026-08-31

### Added

- First-party `gh-manager` skill (#378): declarative, IaC-style GitHub
  repository management (`init → plan → apply` from a `repos.yaml`),
  backed by a TypeScript plan/diff engine and gh-CLI access layer in
  `@moh/core` (`packages/core/src/github-settings.ts`) — apply is
  consent-gated with a rendered diff, and undeclared live settings are
  never touched. Ported from
  [gh-manager](https://github.com/ddlaws0n/gh-manager) by David Lawson
  ([@ddlaws0n](https://github.com/ddlaws0n)) under its MIT license;
  decision recorded in ADR-0017.

### Internal
- Published releases now close still-open issues referenced by GitHub closing directives in delivered PRs; delivery happens at publication rather than the `develop` merge, which preserves the integration-branch workflow (#375).

## [0.9.1] - 2026-08-31

### Added
+
- `/skills update` now opens a TUI modal with selectable, scrollable upstream skill diffs and explicit Apply or Not now actions; applying still revalidates locally modified copies before writing (#372).

## [0.9.0] - 2026-08-31

### Fixed

- MCP security hardening (#354): stdio servers receive only a minimal explicit
  environment (`PATH`, `HOME`, `TMPDIR`, `LANG`, `TERM`, plus declared `env`);
  restarting an untrusted project server re-checks consent; and `__` is now
  rejected as a reserved MCP server/tool-name separator.
- Security (audit SEC-01, #352): a project `moh.json` can no longer
  self-declare an MCP server as `trusted` — the field is ignored on read.
  Persisted "always" consent for project servers now lives in the user
  config (`~/.moh/config` `mcpTrust` section, keyed by project path), so a
  cloned repo never skips the consent gate (ADR-0016).
- Security (audit SEC-02, #352): upstream skills updates validate the
  network-supplied skill name and file keys before writing. A
  traversal-bearing index entry fails the upstream check explicitly, the
  apply path skips malformed updates without writing, and the bundled
  first-party installer routes through the same containment-checked write.

### Added

- The Frontier panel now supports unclaiming (`u`): it removes the current
  user's assignment on every tracker backend (gh, gitlab, local markdown) —
  no permission prompt (reversible, self-scoped).
- Tracker permission requests show the issue reference (`issue: #357`)
  instead of raw JSON, and answering "always" now writes a session rule so
  later Frontier claims no longer re-prompt.
- Frontier claims now open a label-guided workflow chooser. Selecting a route
  pre-fills (but never sends) the minimal slash command and issue reference;
  projects can extend or override label routes through `moh.json` (#357).

## [0.8.0] - 2026-08-30

### Fixed

- Double `Ctrl+C` exit no longer holds the shell prompt for ~3s after the
  UI disappears: the CLI now bounds tracked session cleanup (2.5s budget) and
  terminates explicitly, so lingering event-loop handles — Bun HTTP keep-alive
  sockets from provider traffic — cannot delay a deliberate exit (#341).
- `/skills update` no longer reports `skills up to date` when the skill upstream
  is unreachable: a non-OK, malformed, or invalid index is an explicit failure
  surfaced with its reason (e.g. `skills update check failed (http 404)`), while
  the background startup check stays fail-silent. The default upstream URL now
  points at this repo's main branch (`packages/core/assets/skills/index.json`,
  generated by `scripts/gen-skills-index.ts`) — the previous `moh-workflow`
  org URL never existed (#344).
- The interactive TUI now captures AI SDK warnings through moh's diagnostic
  channel instead of letting raw Node/SDK warning dumps corrupt the transcript
  between chat turns (#347).

### Changed

- Update discovery now polls binary releases and first-party skills every 30
  minutes while the TUI is open, behind the shared `updateCheck` opt-out; skill
  availability persists on status row 2 alongside binary notices and is
  independent of workflow mode (#348).

- Model catalogs: the regeneration script now derives missing
  `thinkingLevelMap` entries by exact model-id + same-wire match across
  pi-ai's catalogs (6 recovered — OpenRouter 4, GitHub Copilot 2;
  residual 120 are unlabelled upstream). The per-model `thinkingModels`
  config declaration remains the escape hatch for gaps (#338).
- Model catalogs regenerated from pi-ai 0.84.4: 113 additional OpenRouter
  thinking-level maps (unmapped `reasoning:true` models drop 212 → 99) plus
  copilot/zai data refresh (#338).
- The `spawn` subagent tool is now registered by default — the built-in
  presets (`research`, `implement`) work with zero configuration; a moh.json
  `agents` section now only overrides presets/provider/concurrency. Inline
  `provider`/`model` refs are validated before any child session is created:
  a hallucinated ref fails fast with a clear error instead of wasting turns (#339).

### Internal

- Release pipeline: bump `upload-artifact` v5→v7 and `download-artifact` v4→v8
  (Node 20 deprecation warnings).

## [0.7.2] - 2026-08-30

### Fixed

- No more false "non-stable (dev) version" notice after `moh update`: a successful
  self-update now refreshes the update-check cache so it agrees with the freshly
  installed binary. The TUI also runs the update check on every launch (the 24h
  cache stays as offline fallback), re-fires it while a session stays open past
  the 24h window, suppresses the nonstable notice when the cache predates the
  running binary, and surfaces an active update notice left-aligned on the
  second row of the status bar — the cwd/branch/mode tail stays in place (#328).
- The reasoning block now stays above the model's reply in the settled
  transcript (and in whole-transcript repaints), matching the streaming
  view. The agent loop persists a completed call's reasoning after that
  call's text deltas; the transcript projection now reorders each call's
  reasoning group above its reply (display-only — the session log is never
  rewritten), and with reasoning display enabled an open reply promotes
  into scrollback at call end instead of paragraph-by-paragraph so the
  reasoning never lands below already-printed text (#326).

## [0.7.1] - 2026-08-30

### Fixed

- Subagent preset defaults no longer get erased when a tool-calling model
  serializes omitted inline fields as empty values. In particular, the
  `research` preset retains its read-only tool allow-list (#323).

## [0.7.0] - 2026-08-29

### Added

- TUI: subagent activity renders as one dedicated transcript block —
  name/preset head, live `running` state while the child works, final
  status with token totals, and a short preview of the child's output
  (persisted on the `subagent_result` event, visible on replay too). Vibe
  mode keeps it as a plain-language line, failures excepted (#320).

### Changed

- CI: GitHub Actions bumped off the deprecated Node 20 runtime —
  `actions/checkout` to v7 and `actions/upload-artifact` to v5 in the CI and
  release workflows (#317).

### Fixed

- Exiting the TUI (double ctrl+c) no longer stalls for seconds while a
  background memory extraction is in flight: session dispose accepts a
  `timeoutMs` budget that aborts the pending maintenance run (the transcript
  window rolls back, so the turns stay eligible for a later run); the exit
  path uses a 2s budget.

- Linux Kitty startup no longer lets a delayed keyboard-capability response
  enter the Home search field; update notices now compare against the
  binary's actual build version (#315).
- TUI: Markdown inline-code URLs inside tables retain literal `:` characters
  instead of leaking marked-terminal's internal colon placeholder (#296).

## [0.6.0] - 2026-08-29

### Added

- TUI: recognized Z.ai openai-compat endpoints now use the vendored pi-ai GLM
  catalog for model selection and the context bar, including the 1M-token
  windows of GLM-5.2/5.3; onboarding also records Z.ai's declared reasoning
  capability automatically (#309, #310).

## [0.5.0] - 2026-08-29

### Added

- TUI: slash completion popup under the textarea — typing `/` opens an
  alphabetical list capped at five visible rows (↑↓ scroll, filtering as you
  type). Enter and Tab both accept the selection: the command lands
  in the textarea followed by a space (ready for the prompt; focus never
  moves to the send chip). Each row reads
  `/command - [s]: description` — `[s]` built into moh, `[u]`
  user-defined — truncated with `…` on narrow terminals.
- TUI: blinking block cursor in the input (slow cadence ~800ms full cycle;
  snaps visible on every keypress).
- TUI: where-you-are row in the status bar — cwd (`▣`, middle-elided so the
  start and the project-directory tail stay readable), git branch, and mode
  chip, right-aligned under the session-state row.
- Slash commands: `/commands`, `/mode`, `/settings`, `/theme` and `/wayfinder`
  join the base registry, always available, listed alphabetically in the
  popup (workflow skill aliases follow when workflow mode is on).

### Changed

- TUI: newline in the input is shift+enter (kitty keyboard protocol —
  negotiated where the terminal supports it); option+enter and ctrl+j remain
  the legacy-terminal fallbacks. The placeholder and the commands panel now
  document shift+enter.
- TUI: the footer no longer shows the `theme` and `thinking` chips; ctrl+t /
  ctrl+y and `/theme` / `/thinking` remain the controls.

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

[Unreleased]: https://github.com/Marco-Cricchio/moh/compare/v0.12.0...develop
[0.12.0]: https://github.com/Marco-Cricchio/moh/compare/v0.11.2...v0.12.0
[0.11.2]: https://github.com/Marco-Cricchio/moh/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/Marco-Cricchio/moh/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/Marco-Cricchio/moh/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Marco-Cricchio/moh/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/Marco-Cricchio/moh/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Marco-Cricchio/moh/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Marco-Cricchio/moh/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/Marco-Cricchio/moh/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/Marco-Cricchio/moh/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Marco-Cricchio/moh/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Marco-Cricchio/moh/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Marco-Cricchio/moh/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Marco-Cricchio/moh/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Marco-Cricchio/moh/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Marco-Cricchio/moh/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Marco-Cricchio/moh/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Marco-Cricchio/moh/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Marco-Cricchio/moh/releases/tag/v0.1.0
