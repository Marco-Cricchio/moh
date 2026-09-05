# Changelog

All notable changes to moh are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer. Each release's GitHub Release description is extracted from the
matching section here at tag time.

## [0.20.1] - 2026-09-05
### Fixed

- **Route fallback cooldown** (#506): when a fallback target is on cooldown,
  moh now fails deterministically with a normalized `invalid_request`
  ProviderError instead of an opaque failure; provider messages matching
  "usage limit" are classified as `quota_exhausted`.

### Changed

- **Docs discoverability**: demo GIF slot and an honest comparison table in
  the README; ADRs and CONTEXT.md are now published in the repo, and the
  ask-moh repo-docs section is gated accordingly.

## [0.20.0] - 2026-09-05
### Added

- **Usage quota modal** (#499): ctrl+q from chat opens a TUI modal with one
  row per provider quota window (5h / weekly / monthly, percent or
  used/limit + reset) with a progress bar and a source badge (● documented /
  ○ provider-reported / — local measured), plus the always-present local
  section (this session's tokens per model from the event log). Backed by the
  narrow `getQuota(endpoint)` core seam (ADR-0004 export): probes the
  endpoint's usage endpoint reusing the auth stores; a broken remote degrades
  to the local section with a discreet note, never an error. Probe is
  on-open only (60s cache, `r` forces refresh); no background polling.
- **Max iterations surface** (#498): the loop cap is now user-facing —
  TUI settings row cycling 50/100/200/500/unlimited (shift+tab cycles back)
  with a warn-at-selection for unlimited, persisted in moh.json;
  `moh run --max-iterations` for headless runs; core sentinel
  `maxIterations: 0` = unlimited (`resolveMaxIterations`/`MAX_ITERATIONS_UNLIMITED`
  exported from `@moh/core`; absent still means 50).
- **Community standards**: Code of Conduct and Security policy.

### Fixed

- **Markdown contrast** (#504): improved Markdown rendering contrast across
  themes.

## [0.19.0] - 2026-09-05
### Added

- **Subagent chips / live panel** (#497): one footer chip per active/recent
  child on its own compact chip row above the action chips (state glyph
  `◐` running, `⏸` stalled after ~60s without log growth, `✓`/`✗` settled;
  ordinal only for duplicate names, overflow `+N`, compact `⊙N` degradation
  under ~100 columns); chips sit at the head of the tab cycle when any exist,
  ←/→ clamp at their edges, Esc or typing returns to the composer. Enter
  toggles the live peek panel: header (name, elapsed, state, current tool)
  plus a live tail of the child's event stream through the new core
  `tailChildLog` seam (ADR-0004 amendment) — consecutive assistant deltas
  coalesce into one truncate-only preview with provider spaces preserved,
  up to five live tail rows while the child runs, a one-line summary
  (`✓ done · Xk tok · result in transcript`) on settle, and auto-dismiss of
  panel and chip ~30s after settlement. The static `subagent` block remains
  the only permanent transcript artifact.
- **README refresh**: non-technical-first README with release/license badges,
  logo, "What is moh?" intro, ask-moh and user-manual sections; CONTRIBUTING
  link fixes (gitignored files no longer linked).

## [0.18.0] - 2026-09-04
### Added

- **File mentions** (#488): `@file` and `@dir` tokens attach a structured
  snapshot on the `user_message` event — file content capped at ~200KB with a
  declared truncation marker, directories a recursive path listing; `read:`
  permission rules gate every snapshot (denied or missing paths produce a
  visible `mention_warnings` chrome event); replay rebuilds the attachment
  text parts, so resume and fork inherit exactly what the model saw. The TUI
  adds a fuzzy `@` path popup over a git-aware file index; `expandMentions`/
  `assembleMentions` are exported from `@moh/core` for headless use.
- **Image mentions** (#490): `@` mentions of png/jpg/webp/gif attach bytes as
  base64 (~5MB cap with visible refusal), promoted to typed image parts only
  when the serving model declares image input — catalog modalities or an
  explicit `capabilities.multimodal: true`; replay rebuilds the image parts.
  The TUI renders inline pixel previews (kitty graphics or iTerm2 OSC 1337,
  `images.preview: auto|on|off`) with a `[image: name WxH]` fallback chip, and
  drag-and-drop pastes as an `@mention`.
- **Multimodal capability declaration**: `capabilities.multimodal` on
  endpoint profiles positively declares image input for catalog-less
  openai-compat/custom endpoints; `false` vetoes even a catalog grant.
- **Model catalogs** regenerated from pi-ai 0.85.0.

### Fixed

- Image preview reliability (#490): the preview is now attached to the
  transcript's user block (key mismatch fixed) and iTerm2 payloads are no
  longer double-encoded.
- File-index git probe is async, unblocking App-based tests (#488).

## [0.21.0] - 2026-09-05
### Added

- **Max iterations per turn** (#498): TUI settings row cycling the
  presets 50/100/200/500/unlimited (enter or → forward, shift+tab back);
  selecting unlimited warns at selection time that the anti-runaway
  safety net is off and persists to moh.json.
- **`moh run --max-iterations <50|100|200|500|unlimited>`** (#498):
  per-run override of moh.json's `maxIterations`; strict parse with a
  clear usage error.
- **`maxIterations: 0` unlimited sentinel** (#498): moh.json accepts any
  integer 0–500; `0` disables the per-turn cap (the default stays 50).

### Fixed

- **Skill update noise** (#517): upstream skill updates identical to the
  bundled copy are suppressed — a first-party skill that matches the
  bundle is no longer offered as an update on every launch.
- **Docs discoverability**: the ask-moh repo-docs section is gated to the
  moh repository and answers from `moh manual` (embedded pages) in any
  directory.

## [0.17.2] - 2026-09-04
### Fixed

- **Home session picker** (#480): action chips on selected list rows use a
  contrasting foreground, so they remain visible on the selection background.

## [0.17.1] - 2026-09-04
### Fixed

- **Home session picker** (#480): selected session action chips are always
  visible and right-aligned; session rows stay visible while moving the
  selection; JSX chrome no longer renders as `[object Object]`.

## [0.17.0] - 2026-09-04
### Added

- **Compaction** (#466, ADR-0022): the CompactionRunner auto-triggers a
  compaction marker when the last measured input crosses 80% of the model's
  context window; `/compact` forces it from the TUI and `moh compact` compacts
  a closed session file without consuming it; `compaction_failed` chrome keeps
  a sticky warning on failure.
- **Session rename** (#477): the `session_renamed` chrome event and exported
  `renameSession()`; rename from the Home picker (`r` or right-arrow) or
  `moh sessions rename <file|id> <name>` — an empty name resets to the derived
  title.
- **Session trash** (#478): `deleteSession`/`restoreSession`/`listTrashedSessions`
  with lazy 30-day retention; Home picker delete chip (`d`, y/N confirm,
  open-session refusal) and `moh sessions delete` + `moh trash list|restore`.
- **Pertinent session banner** (#470, ADR-0021): the resume picker pre-selects
  the most recent unconsumed session as a banner row.
- **Detect-and-fork** (#468, ADR-0020): `session_file_growth` chrome warning
  with a sticky TUI banner and `/fork` fork-now, plus a CLI recovery hint.
- **Session notes** (#467): the notes path is exported and rendered in the
  prompt environment; the core guarantees the path, never the content.

## [0.16.0] - 2026-09-03
### Added

- **User manual** (#457): ten bundled pages embedded in the binary, a
  generated mirror at `docs/manual/`, a filterable TUI modal (`ctrl+h`,
  `/help`), `moh manual [page]` on the CLI, and `/ask-moh` grounding
  with `Manual → <section>` citations.

## [0.15.0] - 2026-09-03
### Added

- **Session Handoff** (#433, #434–#440, #451): hybrid per-project session
  continuity with serial cross-machine delivery. A crash-safe raw handoff
  artifact is maintained locally post-turn; at exit (or on git push) the
  handoff is published non-destructively to a per-user secret gist
  (`moh:handoff:<project-slug>:<gh-user>`). On another machine, `moh`
  discovers the gist at startup, marks stale handoffs (anchor SHA ≠ HEAD),
  and offers newest-wins between the local session and the handoff — the
  accepted handoff seeds a new session as opening context (skill-prompt
  pattern, ADR-0011). Includes: `HandoffTransport` core seam injected by
  clients; onboarding modal with inline `gh` verification (transport
  setting per-project in moh.json, `Not Set` = off with a single
  first-session reminder); Settings panel entry; wayfinder context cited
  in handoffs (tracker writes only behind the explicit `--notify-ticket`
  flag); `moh handoff export|import <file>` manual fallback and
  `moh handoff pull <url>`; payload author isolation (v2 schema, v1
  back-compat); full offline degradation to the local artifact.

- **Per-provider ToS summary cards** (#444, PR #453): eight provider JSON
  assets in `packages/core/src/tos-cards/`; the add-provider wizard prints
  a discreet `ToS: <url> (verified YYYY-MM)` line, and the TUI settings
  panel opens the card with `t` from the endpoint level. Provider docs
  pages under `docs/providers/tos/` generated by
  `core/scripts/gen-tos-docs.ts` and pinned by an anti-drift test.

### Fixed

- provider errors no longer render as `[object Object]` in the transcript
  (#404, PR #454): the error presenter now surfaces the normalized
  `ProviderError` kind and message.

### Changed

- handoff gist republication is non-destructive (#451): the new gist is
  created before the old tagged one is deleted — a failed create never
  destroys the remote copy.
- CI: PR-only checks with parallel jobs and a PTY retry (#441), halving
  CI minutes per merge.
- TUI: multiline input navigates by visual line (#430), with staged
  visual edges and walk-mode history recall.

## [0.14.0] - 2026-09-02
### Fixed

- ask_user inline block freeze (#426): with a question set open, the
  block no longer drives the modal alternate-screen buffer flip (and the
  deferred whole-transcript repaint) — the visible screen stays
  responsive under arrow stress on long transcripts; the block keeps
  exclusive keyboard focus while open.

### Changed

- ask_user block redesign (#426), owner-validated via an interactive
  prototype: at ≥72 columns the block renders as a bordered panel with
  one tab-chip per question (current, answered, pending) and a
  flush-right N/M counter, byte-exact aligned; option descriptions
  word-wrap on their own indented lines; the summary screen shows one
  padded row per question. Below 72 columns it regresses to a compact
  borderless layout without tab-chips or side-by-side previews.
- new `muted` theme token (mid-tone between fg and dim) renders the
  focused option's description in every theme — dim was too dark to
  read, fg was indistinguishable from the question title.

## [0.13.1] - 2026-09-02
### Fixed

- TUI startup regression (#423): the horizontal separator under the text
  area and the blank line after it — dropped when the inline ask_user
  block was inserted (#412) — are back; with a question set open the
  separator sits directly under the text area and the block keeps its own
  padding above BottomBar row 1.

## [0.13.0] - 2026-09-01
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

[Unreleased]: https://github.com/Marco-Cricchio/moh/compare/v0.21.0...develop
[0.21.0]: https://github.com/Marco-Cricchio/moh/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/Marco-Cricchio/moh/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/Marco-Cricchio/moh/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/Marco-Cricchio/moh/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/Marco-Cricchio/moh/compare/v0.17.2...v0.18.0
[0.17.2]: https://github.com/Marco-Cricchio/moh/compare/v0.17.1...v0.17.2
[0.17.1]: https://github.com/Marco-Cricchio/moh/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/Marco-Cricchio/moh/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/Marco-Cricchio/moh/compare/v0.15.0...v0.16.0
[0.14.0]: https://github.com/Marco-Cricchio/moh/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/Marco-Cricchio/moh/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/Marco-Cricchio/moh/compare/v0.12.0...v0.13.0
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
