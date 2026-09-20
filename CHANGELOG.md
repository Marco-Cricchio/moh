# Changelog

All notable changes to moh are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer. Each release's GitHub Release description is extracted from the
matching section here at tag time.

## [Unreleased]

### Added

- **The Jev guardrail's judgment records its verdict** (#843): every
  `jev_judgment` for the bash guardrail now carries `decision`
  (`pass`/`ask`/`deny`) and, on an ask or deny, the key dimension and
  probability the verdict was based on — a complete audit record.

### Changed

- **The transcript shows only notable guardrail outcomes** (#843): an ask
  or a deny renders one `jev · guardrail · <verdict> (<dimension> 0.42)`
  line; a pass renders none — the log keeps every record, only the
  projection changes. Old sessions without a recorded verdict keep their
  previous line on replay.
- **The README's demo slot is filled**: it pointed at
  `docs/assets/demo.gif`, which did not exist, so the README rendered a
  broken image. The GIF shows one full turn of the real TUI — its layout,
  glyphs, block grammar and Tokyo Night palette — including a permission
  prompt being raised and answered before a tool runs.

### Fixed

## [0.40.0] - 2026-09-20
### Changed

- **The core no longer depends on the Jev extension** (#826): `@moh/core`
  used to import the bundled vendor package and read two of its private
  state keys inside session assembly. It now hosts bundled extensions
  generically (`bundledExtensions` on `sessionFromConfig`) and the clients
  mount the first-party sources, so embedding `@moh/core` gives you a core
  with no vendor code and no vendor configuration in its public surface. The
  last thread is gone too: activation is resolved by the **client** (which
  owns the config surface of the code it ships) and handed to the core as a
  boolean, so the core no longer runs an extension-provided predicate over
  your configuration file. For the user nothing changes: entering the API key
  in the Settings entry `Jev (TypeSafe)` still activates Jev, with one
  keystroke and no declaration to write. A malformed `typesafe` block no
  longer breaks session start — `moh jev status` reports it loudly instead.

### Added

- **Loadable extensions** (#834): moh finally loads extensions it did not
  ship. Drop a `.ts`/`.mjs` file in `~/.moh/extensions/`, or declare one in
  `moh.json` `"extensions"`, and the first load asks once — naming the file
  and a SHA-256 of its exact bytes — before enabling it; the answer is
  remembered against those bytes, so editing it asks again. The question
  comes **before the file is loaded**, because loading a module runs it: a
  file you decline, or that nobody could ask you about, is never imported
  and executes nothing. A `moh.json` declaration only *proposes*: a clone
  you never answered for runs no code, in any client. Headless clients
  (`moh run`, `moh serve`, `moh compact`) never prompt — an un-enabled
  extension is skipped with a visible reason and the exit code is
  untouched. No sandbox: an extension runs with moh's own privileges, and
  the manual page says so.

- **Bundled Jev (TypeSafe) integration** (#784): moh can consult the
  TypeSafe service for typed judgments. Activate it by entering an API key
  in the TUI Settings panel entry `Jev (TypeSafe)` (validated once, on save;
  the presence of the key is the state — no toggle, no wizard), check it
  offline with `moh jev status`, and forget about it when TypeSafe is
  unreachable: judgments fail open, the agent behaves as it does today, and
  the only trace is one `∅ jev offline` footer chip. Extension authors get
  the matching contract additions — the `ask` outcome on the tool-call hook
  and the `appendEvent` / `setStatus` observation seams (apiVersion 1.1).

- **Jev model routing** (#787): an opt-in router (Settings entry
  `Jev (TypeSafe)`, item "Model routing", off by default) that picks the
  model serving each turn from three tiers — `economico`, `bilanciato`,
  `potente`. Jev sees only the last message (2 KiB) plus the tier-to-model
  mapping; a switch needs confidence ≥ 0.60 and two turns in a row naming
  the same tier, a manual `/model` suspends the router, and models are
  labeled explicitly in `typesafe.tiers` or ranked by catalog price.
  Extension authors get the `beforeTurn` hook (apiVersion 1.2) — the
  turn-start seam that names the model of the current turn. The router has
  its own session commands, `/routing on|off|auto` and `/model auto`
  (neither writes your configuration), and an extension can now be
  commanded by name through the `extension_control` channel
  (apiVersion 1.3).

- **Jev anti-injection** (#791): an opt-in check (Settings entry
  `Jev (TypeSafe)`, item "Anti-injection", off by default — it is the one
  use case that reads what you typed) against prompt injection. Your
  message (4 KiB) and every `fetch`/`browser` result (8 KiB) are judged
  with two questions; below 0.50 nothing is shown, from 0.50 either signal
  warns on one transcript line (a fired `sensitive` signal adds *do not
  commit or share this content*), and above 0.95 injection the send is
  held by a confirmation modal — `y` sends anyway, `n` returns the text to
  the composer and sends nothing, and headless (`moh run`) refuses the turn
  with one stderr line and an unchanged exit code. Above threshold a web
  result is replaced by a refusal the model can explain, and the session
  log holds that refusal so resume and fork match what the model saw.
  Extension authors get the scoped `onToolResult` inspection seam and the
  `confirm.onResolved` callback (apiVersion 1.4).

- **Jev quality gate** (#789): an opt-in end-of-task review (Settings
  entry `Jev (TypeSafe)`, item "Quality gate", off by default — it is the
  one use case that sends the changed code's diff, up to 32 KiB). When a
  task ends, moh collects the project's own convention documents
  (`AGENTS.md`, `CONTRIBUTING.md` and friends; a repo with none gets no
  gate — rules are never invented) plus the diff of the files the task
  changed, and Jev answers three questions: conventions respected, error
  handling, completeness. Any answer below 0.40 is a finding, and moh
  automatically asks the model to fix the flagged areas — at most two
  correction cycles, marked in the transcript, fail-open when Jev is
  down. Extension authors get the `requestTurn` synthetic-turn door
  (apiVersion 1.6, ADR-0037): one core-mediated correction turn with a
  visible synthetic marker and a core-enforced cap of 2 consecutive
  synthetic turns.

- **Jev use cases are governable while a session runs** (#832) and their
  switches have all three surfaces (#833). The `extension_control` channel
  now speaks one grammar for all seven use cases (`guardrail`, `routing`,
  `classification`, `injection`, `lint`, `rerank`, `skills`):
  `{ cmd: "usecase", usecase, action }`, with the routing-only
  `on|off|auto` form still accepted. In the TUI, `/jev` opens a switchboard
  showing the live state of every use case and flips one for the open
  session — session-warm only, with the asymmetry stated out loud ("the
  config still says off"), and a refusal (the guardrail in yolo, a use case
  this session cannot run) shown as a refusal. The Settings entry gained
  the missing **Classification** row, and the shell got the matching
  persistent forms: `moh jev routing on`, `moh jev classification off`.
  Availability and config are now two different things — a use case whose
  dependency the session has can be switched on for that session even
  though the config says off — and the guardrail keeps no config flag (a
  stored key is its switch), so `moh jev guardrail off` is refused as
  session-only rather than silently ignored.

## [0.39.3] - 2026-09-18
### Fixed

- **OpenCode session identification** (#809): OpenCode Go requires coding-agent
  clients to send a stable session id in `x-opencode-session` for routing and
  prompt caching; requests without it fail with HTTP 400 `MissingSessionID`.
  moh now sends one stable id per process on every OpenCode wire, in both the
  wizard connection test and streaming.

## [0.39.2] - 2026-09-18
### Fixed

- **OpenCode anthropic-wire authentication** (#798 follow-up): OpenCode's
  `/messages` endpoint ignores `Authorization: Bearer` entirely — the wizard
  connection test 401'd on Go's default minimax-m3 even with a valid key. The
  test now sends the key as `x-api-key` with `anthropic-version` on the
  anthropic wire (Bearer elsewhere), matching the streaming path.

## [0.39.1] - 2026-09-18
### Fixed

- **OpenCode wire resolved per model and product** (#798): the OpenCode
  provider no longer assumes one wire per endpoint kind — Zen and Go serve
  different wires for the same model id (e.g. minimax-m3 is openai-chat on
  Zen but anthropic-messages on Go). Wire, endpoint URL, and request body
  are now selected per model and product, fixing the wizard connection test
  (HTTP 401 "Model minimax-m3 is not supported for format openai" on Go) and
  real streaming through route targets.

## [0.39.0] - 2026-09-18
### Added

- **Browser tool** (#774–#778): a native headless Chromium driver with
  read-only navigation and snapshots, URL-scoped permissions and SSRF
  protection, guarded interaction (`click`, `fill`, `select`, `scroll`,
  `press_key`, and `wait_for`), upload containment, staged downloads,
  screenshots, `eval_js`, and optional headful mode.

- **Session analysis report** (#767, PR #785): `moh sessions analyze <file|id>`
  (with `--json`) and the TUI `/session` modal provide a snapshot of the active
  branch's turns, tokens, model usage, costs where priced, tool activity, and
  wall/model time.

- **OpenCode Zen and Go provider** (#795): first-class OpenCode endpoints
  using the OpenAI Responses wire, with browser API-key handoff and official
  live model-catalog discovery with conservative local fallback.

### Fixed

- **Clipboard backend selection** (#764): local platform clipboard binaries
  are preferred over OSC 52 when both are available.

- **Theme studio CI race** (#778): tests wait for the mounted studio instead
  of relying on timing guesses.

## [0.38.2] - 2026-09-17
### Added

- **MPM orientation seed eligibility: symbols + reasoning identifiers with
  confidence tiers** (#759): the automatic orientation plan no longer requires
  the task text to name a mapped path — exact task symbols seed a medium-tier
  plan and recency-weighted identifiers from persisted prior-call provider
  reasoning seed a low-tier, visually subordinate one (suppressed after a
  successful `mpm_query`). Seeds matching more than five files yield no plan
  (`over-threshold`); new fallback reasons and per-session seed statistics are
  metadata only. Deterministic tokenization throughout — no fuzzy matching,
  no LLM in the seed pipeline.

- **Handoff: retry a failed exit publish at next startup** (#758): a handoff
  publish that failed at exit is kept pending and retried automatically the
  next time the project session opens.

### Fixed

- **Todo box renders fully expanded in vibe mode** (PR #761): the TUI todo
  box no longer collapses when a task line exceeds one row.

## [0.38.1] - 2026-09-17
### Fixed

- **Vibe bash hints skip comment lines and carry real arguments** (#755):
  the hint generated for a blocked or failing `bash` call no longer quotes
  leading comment lines as if they were the command, and walks the command's
  words to the first shell operator so the meaningful arguments are part of
  the hint (capped, redirect targets included).

## [0.38.0] - 2026-09-16
### Added

- **User-defined color themes** (#749, PR #751): personal themes live in
  `~/.moh/themes/` (partial colors inherit from a built-in preset via
  `extends`) and are selected with `"theme": "user:<id>"` in `~/.moh/config`.
  The Theme picker (`Ctrl+T`) lists them, applies them immediately, and the
  new full-screen theme studio modal (`e` on a theme) previews and edits
  every palette role live; saves are atomic and collision-checked. Invalid
  or missing themes fall back to tokyo-night with a visible error;
  non-blocking contrast warnings (≥3:1 vs background) flag low-contrast
  text/accent roles.

### Changed

- **report-bug skill: English-only issues** (PR #750): issues filed through
  the skill are enforced English-only, per repo policy; the bundled skills
  index was regenerated accordingly.

## [0.37.0] - 2026-09-16
### Added

- **Usage quota modal as bordered tables** (#742): the TUI usage quota modal
  (ctrl+q) renders provider quota windows and the local section as clean
  bordered tables with progress bars, replacing the prose layout.

### Changed

- **mpm_query: term-agnostic graded seed resolution** (#743, PR #744): seed
  candidates are graded across path, symbol, and term dimensions instead of
  exact-match-only, with precise fallback reasons for discarded or ambiguous
  candidates.

### Documentation

- **README refresh** (#741): documents local usage telemetry and
  OpenAI-compatible endpoint profiles; refreshed CLI table.

## [0.36.0] - 2026-09-16
### Added

- **`/copy` command** (#672, PR #736): copies the last assistant reply to the
  clipboard from the TUI composer.

### Changed

- **mpm_query improvements** (#737, PR #738): the map is served during
  updates instead of being unavailable, stale seeds are refreshed on
  query, seed identity is folded, and fallback reasons are more precise.

## [0.35.1] - 2026-09-16
### Fixed

- **grep/glob crashed with ENOTDIR on file paths** (#731, PR #732): pointing
  `grep` at a single file (a natural usage) crashed with an uncaught
  `ENOTDIR` from the directory scan — about 40% of all observed tool
  failures. A file `path` is now searched directly; `glob` with a
  literal file pattern returns the file when it exists instead of
  crashing the scan.

- **Tolerant tool schemas and structured failure kinds** (#731, PR #732):
  common model mistakes are normalized at the tool layer instead of
  failing the call — `ask_user` trims over-long headers and fuzzy-snaps
  `suggested` to an option label; `read` coerces `null`/`0` `offset`/
  `limit`; `bash` exit 127 from `rg`/`grep -P` now hints at the built-in
  grep tool. Failed `tool_result` events carry a structured `errorKind`
  (schema-validation, permission, timeout, io, command-exit, …), and
  `moh usage tools` shows the failure breakdown per kind.

## [0.35.0] - 2026-09-16
### Added

- **Local usage telemetry and reports** (#714–#718): `moh usage` reports
  per-model calls and input/output tokens, tool success/failure and duration
  statistics, route fallbacks/errors, and redacted CSV/JSONL exports across
  local sessions. The TUI Home and quota modal also show bounded local usage
  summaries.

- **Estimated model costs** (#719): `moh usage` and the TUI quota modal show
  clearly labelled approximate USD estimates alongside measured tokens when a
  model has a maintained price record. Pricing is release-pinned to the
  vendored catalog; unknown, ambiguous, and placeholder-price models remain
  tokens-only.

- **Built-in OpenAI-compatible endpoint profiles** (#726): onboarding and
  guided setup recognize 16 hosted endpoints with their API-key environment
  variables, model catalogs, and wire compatibility metadata.

### Changed

- **Faster local test execution** (#721): PTY integration tests run in
  parallel by default with bounded batching and isolated retry.

## [0.34.3] - 2026-09-14
### Fixed

- **Endpoint name collision could capture user-stored credentials** (#695, PR #703):
  a project `moh.json` could declare an endpoint with the same name as a
  user endpoint but a different `type`/`baseUrl`; credentials resolved by
  bare name (API keys and auto-refreshing subscription tokens) would be
  sent to the project-supplied `baseUrl`. The merge now fails loud on a
  name collision with differing identity — consistent with the
  no-silent-fallbacks assembly principle; matching identities merge as
  before.

- **Directory `@` mentions bypassed the permission gate** (#696, PR #704):
  directory mentions attached a recursive listing before the `canRead`
  gate and accepted absolute/`..` paths, silently enumerating out-of-root
  directories into the event log. Out-of-root (or denied) directory
  mentions now produce a visible `mention_warnings` entry and no
  attachment; in-root listings are unchanged; `assembleMentions` fails
  closed when a caller supplies no gate.

- **fetch: DNS-rebinding TOCTOU between host check and connect** (#697,
  PR #705): the fetch tool verified the resolved hostname then dialed a
  second, independent resolution, so a short-TTL rebinding host could
  reach private/loopback targets. Connections are now pinned to the
  DNS-verified address (via `undici`'s dispatcher); every redirect hop
  dials verified addresses only.

- **Bash metachar guard residual** (#698, PR #706): under prefix-matched
  allow rules, herestrings (`<<<`), input redirection (`<`), and unquoted
  `$VAR`/tilde operands smuggled behavior the rule author never saw. All
  three now force an ask; quoted occurrences do not.

- **Equal-specificity allow/deny resolved to allow** (#699, PR #707):
  with identical specificity the allow rule won, contradicting the
  documented "deny beats allow when at least as specific". Equal keys now
  tie-break toward deny.

- **Handoff import passed authorless payloads through the author check**
  (#700, PR #708): `handoff pull` with an expected author configured
  silently accepted a v1-style payload with no `author` field. The check
  now fails closed.

- **Subagent live panel rendered tail text unsanitized** (#701, PR #710):
  the live peek panel was the one remaining TUI path rendering
  model-controlled strings without the render sanitizer (SEC-08
  follow-up). Tail lines are now sanitized like every other surface.

- **MPM shard reads were not contained** (#702, PR #711): `readRecord`
  joined the shard string from the manifest without a containment check;
  a corrupt/hostile manifest could point reads outside the project-map
  directory. Escaping shards are treated as corruption — projection
  discarded and rebuilt.

## [0.34.2] - 2026-09-14
### Fixed

- **Cold handoff scan hit a nonexistent REST endpoint** (#680, PR #681): the
  cold-start scan (the `o` door on Home, "resume from another machine")
  called `discoverGistHandoffs` against `user/gists` — an endpoint that does
  not exist — so the scan always 404'd and silently returned "no published
  handoffs found" on every machine. The scan now queries `GET /gists` (the
  same endpoint `gh gist list` uses); a regression test pins the full gh
  argv including the endpoint.

### Changed

- **`MOH_DEBUG=handoff` discovery logging** (#682, PR #682): handoff
  discovery decisions (gates, candidates, selection) can now be traced with
  `MOH_DEBUG=handoff`, enabling diagnosis of "no offer row" reports without
  guessing from silence. The feature stays fully silent by default.

## [0.34.1] - 2026-09-14
### Fixed

- **Startup crash on the Home screen** (#678, PR #678): `importedHandoffFile`
  resolved the project slug against the home's parent directory
  (`projectSlug(cwd, join(home, ".."))`), so identity resolution probed
  `/Users` (or `/home`) and attempted `mkdir /Users/.moh` — EACCES crash
  at launch on macOS and Linux. Latent since #440; surfaced by the #675
  fix turning Home-screen handoff discovery on. The real home is now
  passed; a regression test pins the resolved path under
  `<home>/.moh/projects`.

[Unreleased]: https://github.com/Marco-Cricchio/moh/compare/v0.40.0...develop
[0.40.0]: https://github.com/Marco-Cricchio/moh/compare/v0.39.3...v0.40.0
[0.39.3]: https://github.com/Marco-Cricchio/moh/compare/v0.39.2...v0.39.3
[0.39.2]: https://github.com/Marco-Cricchio/moh/compare/v0.39.1...v0.39.2
[0.39.1]: https://github.com/Marco-Cricchio/moh/compare/v0.39.0...v0.39.1
[0.39.0]: https://github.com/Marco-Cricchio/moh/compare/v0.38.2...v0.39.0
[0.38.2]: https://github.com/Marco-Cricchio/moh/compare/v0.38.1...v0.38.2
[0.38.1]: https://github.com/Marco-Cricchio/moh/compare/v0.38.0...v0.38.1
[0.38.0]: https://github.com/Marco-Cricchio/moh/compare/v0.37.0...v0.38.0
[0.37.0]: https://github.com/Marco-Cricchio/moh/compare/v0.36.0...v0.37.0
[0.36.0]: https://github.com/Marco-Cricchio/moh/compare/v0.35.1...v0.36.0
[0.35.1]: https://github.com/Marco-Cricchio/moh/compare/v0.35.0...v0.35.1
[0.35.0]: https://github.com/Marco-Cricchio/moh/compare/v0.34.3...v0.35.0
[0.34.3]: https://github.com/Marco-Cricchio/moh/compare/v0.34.2...v0.34.3
[0.34.2]: https://github.com/Marco-Cricchio/moh/compare/v0.34.1...v0.34.2
[0.34.1]: https://github.com/Marco-Cricchio/moh/compare/v0.34.0...v0.34.1

## [0.34.0] - 2026-09-14
### Added

- **`moh serve` — RPC mode** (#525, PRs #668/#671): a headless mode that
  drives a session over stdin/stdout as LF-delimited JSON lines
  (protocol v1, `docs/serve-protocol.md`): initialize/handshake, send
  with streaming events, permission decisions passed through, zero
  `@moh/core` changes. Review-hardened: non-string permission rules
  fail loud, version mismatches surface in the handshake.
- **MPM fuzzy suggestions on `mpm_query` no-result seeds** (#669,
  PR #673): when a nominated seed matches nothing, the tool returns
  ranked near-miss candidates (path suffix and symbol-name distances)
  instead of a bare empty result, so the model can self-correct in the
  same turn.

### Fixed

- **TUI oversized-frame flicker** (#622, PR #674): when a frame's output
  height reached the terminal's row count, Ink permanently took its
  fullscreen path (clearTerminal + full reprint on every render, wiping
  scrollback at ~22Hz). All timer-driven re-renders (typewriter reveal
  pacer, composer cursor blink, live ⏱ elapsed timer) are now gated
  behind the `blocked` state; PTY regression test asserts near-zero
  clearTerminal in an idle window.
- **Lost first keystroke in the tree bookmark-name prompt** (#637,
  PR #667): a keystroke landing in the same tick as the naming state
  change was handled by the stale input closure and dropped; the input
  handler now reads a sync ref (React state only mirrors for render).
- **Handoff discovery never ran on the Home screen** (#675, PR #676):
  with `handoff.transport: "gist"`, a newer handoff published from
  another machine was never offered on Home — the startup-discovery
  effect's guard was inverted and only ran on the direct-chat path,
  where the offer has nowhere to render. New App-level integration test
  covers App → Home → discovery.
- **Friendly note for the expected `organization_id`-less OpenAI mint
  skip** (commit 793e4ba): the mint-selection skip path logs a clear
  explanation instead of a bare warning.

[0.34.0]: https://github.com/Marco-Cricchio/moh/compare/v0.33.0...v0.34.0

## [0.33.0] - 2026-09-13
### Added

- **MPM model-nominated queries — the `mpm_query` tool** (ADR-0028, PR #664):
  when MPM is active the session carries a read-only `mpm_query` tool: the
  model nominates one seed (a mapped path, a unique path suffix, or a symbol
  name) and receives the orientation plan's trusted format, every entry
  re-hashed fresh against the mapped record and locally proven — hallucinated
  or ambiguous candidates are discarded honestly, never guessed. The full
  result persists in the event log (the accepted exception to "MPM never in
  the event log" — a tool result the model consumed, not map state).
  Subagents get the tool via preset allow-lists (the `MpmService` never
  leaves the parent session); diagnostics distinguish the `model-seeded`
  fallback reason. Documented in the extending chapter and glossary.
- **New bundled manual page "What moh offers"** (PR #665): a high-level tour
  of all moh macro-features, registered in the bundled manual and mirrored
  to `docs/manual/`. The manual modal now uses the shared chat Markdown
  renderer — page text word-wraps and is never truncated, and Markdown
  blank lines render as real vertical spacing between paragraphs.

### Fixed

- **MPM same-timestamp edit detection** (commit 6661707): external edits
  landing with the same mtime second as the mapped record were skipped by
  the freshness scan; the lifecycle now hash-checks instead of trusting
  the timestamp alone.

## [0.32.3] - 2026-09-13
### Fixed

- **MPM diagnostics coverage symbols** (commit 2ef51d8): the `moh mpm`
  coverage line always reported `(0 sym)` per language because the
  per-language symbol counter was never incremented — only the global
  total was. Per-language coverage now matches the total.

## [0.32.2] - 2026-09-13
### Fixed

- **MPM lifecycle livelock** (PR #660): the session wired the lifecycle's
  `isBusy` as `queue.pending() !== null`, but `pending()` returns a boolean —
  the comparison was always true, so the lifecycle believed a turn was
  perpetually active: sweep budget permanently zero, external drift never
  refreshed, and the TUI status chip stuck on `updating` ("mapping") for the
  whole session. The boolean now passes through; a session-level regression
  test (injectable timers) verifies the drift is mapped and the status
  converges back to `ready`.

## [0.32.1] - 2026-09-13
### Fixed

- **MPM stale first-sight adoption** (PR #655): an external edit landing
  before the session's first periodic scan was adopted blind and the record
  frozen stale forever. First sight now hash-checks against the mapped
  record; only a real drift triggers a refresh.
- **xai / kimi-coding auth** (PR #656): the standard OIDC `email` claim is
  retained during the token exchange instead of being dropped.
- **MPM lifecycle honesty** (PR #657, ADR-0027): the debounced
  `noteExternalChange` seam shipped in #617 without any production caller;
  it is removed. External changes are observed solely by the periodic
  mtime+hash scan (ADR-0027 documents the one-channel-per-producer design).

## [0.32.0] - 2026-09-13
### Added

- **MPM opt-in activation with a per-project override** (ADR-0026, PR #652):
  the Moh Project Map is now **disabled by default** — the user default in
  `~/.moh/config` (`mpm.enabled`) must opt in. The project's moh.json
  `mpm` section becomes a two-way override: an explicit `enabled: true`
  opts the project in over a global default off, `enabled: false` opts it
  out over a global opt-in, absent = inherit (this reverses #618's
  restrict-only precedence). New settings-panel row "Moh Project Map"
  (inherit / on / off) writes moh.json through the guardian; changes apply
  to new sessions.

### Fixed

- **MPM initial projection build** (PR #650): a project never mapped before
  could never become mapped — activation gated on an existing manifest
  while no production path built the projection. `sessionFromConfig` now
  builds the initial projection (fail-safe, metadata only, honoring
  resolved exclusions) before activation; a build failure degrades to no
  MPM, never a session error.
- **OpenAI auth** (PR #651): the standard OIDC email claim is retained
  during token exchange.

## [0.31.0] - 2026-09-13
### Added

- **Moh Project Map (MPM)** (spec #613): a local, deterministic, rebuildable
  structural projection of one project workspace that orients the agent
  automatically — no separate indexing command, no LLM extraction, no remote
  service.
  - Core foundation (#614, PR #636): one headless `MpmService` per project
    owning sharded JSON under `~/.moh/projects/<slug>/project-map/` with an
    atomically-flipped manifest, in-memory inverse indexes, a small
    append-only crash journal, and a read-only query contract with
    provenance. Corrupt or incompatible data is discarded and rebuilt, never
    migrated. Metadata only: never source content, MemoryStore, or the event
    log.
  - Deterministic extraction (#615, PR #638): TypeScript/JavaScript full
    symbols and import/require relations (test→subject `references` edges);
    JSON/YAML/TOML config-links (lockfiles excluded as generated); Markdown
    mapped silently; safety-first discovery honoring `.gitignore`, MPM
    exclusions, generated/vendor/binary/oversize hard exclusions, and a
    fixed sensitive-file denylist that no negation can rescue.
  - Tier A languages (#639, PR #641): Python, Go, C/C++, PHP, Shell, and
    Lua with path-based relations only (Go resolves imports via walk-up to
    the nearest `go.mod`).
  - Tier B languages (#640, PR #642): Rust, C#, Swift, and Kotlin with
    module/namespace relations anchored by their project files
    (`Cargo.toml`, `csproj`, `Package.swift`, per-language config
    capabilities built once and shared).
  - Targeted orientation plans (#616, PR #643): a small, source-cited,
    advisory plan injected into the prompt's `mpm` section for eligible
    codebase tasks — every entry extracted and fresh (re-hashed against the
    mapped record), cited with path, coordinate, relation, and reason.
    Conservative local eligibility: stale or unsupported scopes get no plan
    at all, and plans are turn-scoped with no effect on tool access or
    source-verification requirements.
  - Freshness and resource lifecycle (#617, PR #644): session-lifetime
    debounced background refresh with edit-priority queueing, busy-turn
    yielding (a turn never waits for MPM), per-slice file and time budgets,
    honest `ready | updating | unavailable` status, and LRU quota eviction
    (20k files / 64MB defaults).
  - User controls and CLI diagnostics (#618, PR #645): user-level `mpm`
    section in `~/.moh/config` (`enabled`, `quota`, `exclude`); the
    project's moh.json `mpm` section is restrict-only (it can disable, never
    force against a user disablement); one resolver with strictest-quota and
    union-exclusion semantics; orientation fallback reasons tracked; and
    `moh mpm` (`--json` for clients) as a read-only, redacted diagnostics
    projection.
  - TUI status and inspection (#619, PR #646): a discreet first-row status
    chip (`MPM ✓ ready / ↻ updating / — unavailable`) and an on-demand
    project-map inspection modal with per-language coverage.
  - Session continuity (#620, PR #647): subagents receive a bounded,
    read-only orientation snapshot for their task (no service, lifecycle,
    or mutation surface reaches the child); handoff transports zero MPM data
    but its file/test hints validate locally into a non-blocking warm-up
    priority; a project identity migration relocates `project-map/` with the
    project data and the relocated map is revalidated against the active
    root before use (absent files are dropped, never trusted).
  - End-to-end release gate (#621, PR #648): a maintained multi-language
    corpus driving end-to-end scenarios — targeted multi-file orientation,
    ordinary fallback, external edits, disabled mode, subagent snapshots,
    handoff warm-up, identity migration, disposable-cache recovery,
    large-workspace budgets, foreground responsiveness, and a comparative
    scenario proving the cited plan bounds the candidate set that ordinary
    exploration would have to walk.

[0.33.0]: https://github.com/Marco-Cricchio/moh/compare/v0.32.3...v0.33.0
[0.32.3]: https://github.com/Marco-Cricchio/moh/compare/v0.32.2...v0.32.3
[0.32.2]: https://github.com/Marco-Cricchio/moh/compare/v0.32.1...v0.32.2
[0.32.1]: https://github.com/Marco-Cricchio/moh/compare/v0.32.0...v0.32.1
[0.32.0]: https://github.com/Marco-Cricchio/moh/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/Marco-Cricchio/moh/compare/v0.30.0...v0.31.0
## [0.30.0] - 2026-09-11
### Added

- **Perceived liveness in the transcript** (#634, prototype `alive-proto`
  variant C): running-block heads cycle animated glyph frames (`◔ ◑ ◕ ●`)
  on an independent ~120ms clock gated on the active turn — the beat
  survives stream event gaps, so the seconds between blocks no longer read
  as a stall. A running bash command now streams its partial output as a
  dim **scrolling tail** (last 9 lines) inside the volatile block:
  `ToolContext.onProgress` chunks relay through the session's ephemeral
  live channel as `tool_progress` events (never persisted); settled
  blocks keep their usual result cap, so scrollback determinism (#194)
  is untouched, and the settled timer (`✓ bash · 8s`) persists exactly
  as before (#300).
- **Always-open todo box**: the todo tool's transcript block renders its
  full task list in both dev and vibe modes — the task list reads as a
  persistent panel, not a capped log.

### Changed

- Style guide: documented the liveness treatment and the todo exception
  (`docs/tui-style-guide.md`).

[0.30.0]: https://github.com/Marco-Cricchio/moh/compare/v0.29.0...v0.30.0

## [0.29.0] - 2026-09-11
### Added

- **Session bookmarks** (#579): the `tree_bookmarked { to, name? }` chrome
  event — append-only, last-wins per node, an empty name clears — with
  the `bookmarkNode(file, to, name?)` core export and the live
  `session.bookmarkNode(to, name?)` twin. Targets accept event ids and
  `line:N` bridges (bookmarking a pre-tree turn works). Bookmarks are
  never in model context; they count for topology. Core-side only: the
  TUI `/tree` panel (#581) and `moh sessions bookmark` (#582) build on
  it.
- **Compaction on the session tree** (#578): the compaction marker now
  carries an `upToId` pointer and covers only the **active root→head
  path** — markers resolve on-path (last marker on the path wins; a
  marker on an abandoned branch is invisible until that branch becomes
  active again) and land on the branch actually summarized, even if the
  head has already moved. A dangling pointer restarts context from the
  session start with a visible warning (`compaction_dangling` chrome in
  replay and the TUI). Legacy numeric `upTo` markers keep reading
  positionally. `/compact` and `moh compact` are unchanged in shape;
  `moh compact` still never consumes a session.

## [0.28.0] - 2026-09-10
### Added

- **Cold-directory wizard** (#595): launching moh in a directory that is not
  an initialized project now offers to clone a repository — the wizard
  discovers the handoff gist, clones, pulls the referenced session, and seeds
  a session so you land inside the ongoing conversation. Core seams: cold
  gate, clone, pull-to-import; production gist fetch wired into the pull.
- **Handoff hardening** (#593/#594): publish resolves the repo URL lazily at
  publish time (never sync git probes at transport construction) and a
  newer-remote guard prevents publishing a stale handoff over a newer one;
  gist discovery scans across projects with pagination, so a handoff
  published from another machine is found regardless of which project it
  belongs to.
- **Test suite ~480s → ~275s**: the PTY job runs through a parallel runner
  (2 workers on the 2-vCPU CI runner), the #304 re-run ledger is driven
  through a `rerunMinMs` test seam instead of real sleeps, and the six
  previously skipped flaky TUI groups were rewritten from fixed sleeps to
  frame-condition waits and un-skipped — the `MOH_SKIP_FLAKY` mechanism is
  retired (`gh` runs through an async spawn, unblocking the event loop).

### Changed

- Project identity: a project with a git `origin` remote now derives its
  slug from the canonical `host/owner/repo` form (case-insensitive; the
  protocol, trailing `.git`, and embedded credentials are ignored), so
  two clones of the same repository share one
  `~/.moh/projects/<slug>/` directory — sessions, memory, and handoff
  discovery no longer require committing `.moh/project.json` (#591).
  Projects without `origin` keep the uuid-derived identity unchanged. A
  UUID project that later gains an origin migrates once, atomically, to
  the remote slug with a durable migration note (#592; dot-segment path
  escapes rejected).

### Fixed

- **Bash tool title with leading comments** (#600): commands preceded by
  comment lines show the actual command in the tool title instead of the
  comments.

## [0.27.0] - 2026-09-09
### Added

- **`/report-bug` skill and GitHub issue templates** (#573): turns a broken
  experience into a reproducible, agent-ready GitHub bug report — it gathers
  environment and evidence, asks only the questions needed to make the report
  actionable, and opens the issue through the matching template. Bundled
  bug-report and feature-request templates provide a consistent public
  contribution path.
- **`/prototype` skill** (#571): a first-party workflow skill for exploring
  an interface or interaction before implementation, with dedicated logic and
  UI guidance; discoverable through ask-moh and the workflow manual.
- **Session tree decision record** (ADR-0023): ratifies the session-tree
  direction and its in-place branching model.

### Fixed

- **Markdown table widths** (#583): table columns are allocated from actual
  cell content rather than an even split, so narrow columns no longer waste
  terminal width while long content wraps where it belongs.

## [0.26.0] - 2026-09-08
### Added

- **Native-scrollback streaming with typewriter reveal** (#562): the
  human-scroll architecture lands — finalized lines are pushed into the
  terminal's native scrollback, the volatile tail shrinks to the row still
  forming, and replies reveal at a human pace: char-level horizontal
  word-flow (~300 chars/s with bounded catch-up acceleration, configurable
  via `MOH_TYPEWRITER_CHARS`), cutting only at clean boundaries (end of
  source line, word boundaries inside paragraphs, table cell edges) so
  partial tables never re-interpret. Late reasoning chunks render below the
  forming reply, the reveal cursor opens only on a real settle, and the
  reveal drain scales with the buffer so a long reply is never visibly
  behind. Settled Markdown is deduplicated against promoted chunks by
  content, open Markdown stays visible while streaming, and reply identity
  is preserved across the promotion handover. Streaming oracles were
  rebuilt for the reveal era and the PTY harness commits scrollback with
  sync blocks for deterministic checkpoints.

### Fixed

- Late reasoning chunks no longer interleave above the forming reply;
  reasoning seal + promotion are waited out before scrollback checkpoints.

## [0.25.1] - 2026-09-07
### Fixed

- **Verified per-provider live model listing contracts** (#551 follow-up):
  the generic `/models` assumption is replaced with verified provider-specific
  adapters (ChatGPT-Codex slug-shaped listing, Anthropic, Google, OpenRouter,
  xAI), a shared cache/merge layer, and a conservative metadata projection —
  never hardcoded model backfills. Live catalog results now also surface
  discreetly in pickers as a cached/static fallback notice instead of being
  fully fail-silent, and `/model` and Settings share the same live-catalog
  projection (the Settings catalog-only read is corrected).

## [0.25.0] - 2026-09-07
### Added

- **Live model-list augmentation** (#551): catalog-backed providers can
  augment their vendored model catalog from the provider's live model list;
  the `/model` picker shows discovered models alongside the curated catalog,
  preserving catalog metadata where it exists and keeping unknown live models
  selectable through a conservative projection. The core exposes the narrow
  live-catalog seam and caches results; broken remote lookups degrade silently
  to the vendored catalog.

### Fixed

- **Open Markdown during streaming** (#556): incomplete Markdown is kept out
  of the volatile streaming block until it reaches a stable boundary, so
  partial structured output no longer causes visual duplication or unstable
  layout while a reply is still arriving.

## [0.24.1] - 2026-09-07
### Fixed

- **ask_user tolerance for omitted `suggested`** (#552): GLM-class providers
  emit `ask_user` arguments that fail zod validation when `suggested` is
  omitted, producing failed tool calls and repeated retry boxes in the
  transcript. The schema now defaults the field, so the tool call succeeds
  and the model's fallback-to-chat path is no longer triggered by validation.
- **Compact retry records**: retry records keep less payload per attempt.

## [0.24.0] - 2026-09-07
### Added

- **Rename with ctrl+r** (#547): sessions can be renamed in-chat — ctrl+r
  opens the rename prompt from the composer (with usage hint and cancel via
  Esc), the rename stays reachable from session chips, and the display name
  updates in place without leaving the session.

### Fixed

- **Markdown duplication and unstable mode toggle** (#548): resets emission
  state and forces a repaint on grammar changes (vibe→dev→vibe) — the same
  Static cursor discipline of #544 applied to the repaint path, fixing
  duplicated bullet/numbered lists and unstable display toggling reported on
  v0.23.2.

## [0.23.2] - 2026-09-06
### Fixed

- **Append-only Static emission across live-reasoning handovers** (#544):
  Ink's forward-only `<Static>` counter no longer re-emits reordered chunks
  when the live-reasoning chain hands over to the canonical projection — the
  tail of a fix that closes the reprint/duplication family from the note-33
  streaming work.
- **PTY tests use readiness waits** (#543): fixed pump budgets in the PTY
  harness are replaced by deterministic readiness waits, removing the
  timing-related flake class from the TUI test suite.

## [0.23.1] - 2026-09-06
### Fixed

- **Streaming viewport with visible reasoning** (#537): restores the
  incremental viewport growth of #526 when provider reasoning display is on —
  #531 had disabled early structured-Markdown promotion to prevent duplicate
  replies, pushing closed reply sections back into the volatile box
  (grow/clip, displaced footer). Duplicate late-reasoning blocks are now
  prevented by appending reasoning projections only (never replacing), keyed
  on the coalesced first-event group, so reply promotion stays on and no
  block renders twice. Validated against a real GLM production trace.

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

## [0.23.0] - 2026-09-06
### Added

- **In-session rename command** (#534): `/rename <name>` renames the current
  session without leaving chat, persists the existing `session_renamed` chrome
  event through the core seam, and confirms the exact display name; `/rename`
  with no arguments is non-mutating and shows usage. The Home picker shows the
  name after reopening.

## [0.22.0] - 2026-09-06
### Added

- **Deterministic headless eval harness** (#524): first-party, cassette-driven
  end-to-end scenarios exercise real core seams — tools, permissions, session
  assembly, fork and resume — with deterministic scoring and a dedicated CI
  `evals` job. The harness is extensible through a declarative scenario format
  and continues later steps on the fork when a scenario branches.

### Fixed

- **Duplicate agentic replies with visible reasoning** (#531): structured
  intermediate replies are now held until provider reasoning seals, so the
  TUI no longer renders the same reply twice when reasoning display is on;
  canonical rebuild still handles a failed model call after partial output.

## [0.21.1] - 2026-09-06
### Fixed

- **Streaming viewport growth** (#526, vision note 33): during long model
  output the volatile box no longer grows line-by-line pushing the footer
  away — closed Markdown segments (paragraph, stable list item, closed fence)
  and completed reasoning lines are promoted incrementally into scrollback
  while only the current segment/line stays volatile; reasoning streams
  wrapped at terminal width with a 1-line live tail; a clipped streaming
  table keeps its header visible without flickering; fully promoted live
  blocks disappear from the volatile area. Nothing is lost — the full text
  is always in the event log and the settled transcript.
- **Unreadable code blocks and heading rules** (#527): syntax-highlighted
  fences now use the active theme's truecolor palette instead of
  highlight.js's default ANSI-16 colors (keywords/strings were near-invisible
  on the code-block tint in several themes); the heading rule renders in a
  contrasting color. Contrast audit extended to every bundled theme
  (24 checks, all ≥3:1).

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

[0.30.0]: https://github.com/Marco-Cricchio/moh/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/Marco-Cricchio/moh/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/Marco-Cricchio/moh/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/Marco-Cricchio/moh/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/Marco-Cricchio/moh/compare/v0.25.1...v0.26.0
[0.25.1]: https://github.com/Marco-Cricchio/moh/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/Marco-Cricchio/moh/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/Marco-Cricchio/moh/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/Marco-Cricchio/moh/compare/v0.23.2...v0.24.0
[0.23.2]: https://github.com/Marco-Cricchio/moh/compare/v0.23.1...v0.23.2
[0.23.1]: https://github.com/Marco-Cricchio/moh/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/Marco-Cricchio/moh/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/Marco-Cricchio/moh/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/Marco-Cricchio/moh/compare/v0.21.0...v0.21.1
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
[0.2.0]