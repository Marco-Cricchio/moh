# Changelog

All notable changes to moh are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer. Each release's GitHub Release description is extracted from the
matching section here at tag time.

## [Unreleased]

## [0.61.0] - 2026-10-09

### Added

- **Composer bang commands** (#1288, PR #1289, ADR-0076): `!cmd` in the chat
  composer runs a real bash tool call through the session's own ToolRunner —
  no second shell channel, no loop change. `!cmd` is execute-only; `!!cmd`
  executes and auto-sends the truncated output as the next user message;
  `\!` escapes a literal leading `!`. The same permission rule grammar,
  extension veto and pathScopes apply — bash denied ⇒ `!` denied — with a
  reduced y/n-only consent (the `source: "user"` ask variant, the
  client-side twin of ADR-0031's extension-ask reduction); yolo and
  auto-accept lift the prompt exactly like a model call. The timeout is
  fixed at 120s on the `!` path and real `tool_call` + `tool_result` events
  land in the transcript, so the agent sees what ran. Public surface
  (ADR-0004): one new `AgentSession.runBash` method; everything else is
  TUI-owned.

### Changed

- **Model catalog refresh**: 9 metered prices updated (routine drift).

## [0.60.0] - 2026-10-09

### Added

- **Retro findings** (#1274, #1275): sessions accumulate retro findings
  automatically — deterministic checks at close, judgement categories
  (navigation, standards) from a maintenance subagent over batches of 10
  closed sessions. `moh retro` / `/retro` opens the report: findings
  ordered by confidence with their category, evidence, dismissal lineage
  and a concrete proposed application; `d` records a durable dismissal
  (repeated dismissals raise the category's extraction bar) and applying
  a change needs explicit per-application confirmation, appended under a
  `## Retro findings` heading. The only unprompted surface is one
  digest line per 48 hours. Nothing reaches the system prompt.
  (ADR-0075, PRs #1279, #1285.)

### Fixed

- **Lanes own their dependency install** (#1280, ADR-0060 amendment 5). A
  lane's `node_modules` is no longer a symlink to the checkout's install:
  one `bun install` inside a lane used to repoint `@moh/*` for every lane
  and the main checkout, so every worktree compiled and tested one arbitrary
  lane's sources. Each lane now runs the install its own project declares
  (`lanes.setup` in `~/.moh/config`, then `package.json`'s `packageManager`,
  then the lockfile table), records the outcome and the lockfile fingerprint
  on the lane, and converts a store it does not own — including the old
  shared one — on its next open. A failed install leaves the lane usable,
  says so, and is retried on the next open. The checkout is never mutated
  automatically: `moh lanes list` reports a drifted checkout read-only, and
  the new `moh lanes repair [--apply]` removes the workspace links and
  reinstalls.
- **Yolo denies and records extension asks** (#1276, ADR-0031): in yolo mode
  an extension `ask` is no longer silently granted — the call is denied
  explicitly and a `permission_denied` record names the extension and the
  reason. Yolo lifts moh's own prompts; it never turns an extension
  question into an implicit grant.
- **#1262 low-severity audit backlog completed** (#1277): both fetch
  transports enforce a streaming 2 MB decompressed body budget and refuse
  HTTPS→HTTP redirect downgrades; `git config --list` / `--get` output is
  redacted of credential-shaped values; ignored-file changes invalidate the
  bash re-run ledger fingerprint.
- **Model picker on ctrl+l** (#1281): the picker opens on `ctrl+l` — the
  ctrl key every terminal actually delivers.

### Changed

- **Model catalog refresh**: 23 metered prices updated (routine drift).

## [0.59.3] - 2026-10-08

### Security

This is a security-hardening release: the nine findings from the October
security audit, each fixed behind its own PR.

- **MCP/network hardening** (#1254, PR #1263): stdio transport output buffer
  cap, HTTP timeouts, and redirect/address pinning so a redirecting MCP
  endpoint cannot pivot the connection.
- **git tool** (#1261 + #1257, PR #1264): transient-config options (`-c`) and
  write-path options (`--output`, `--file`) are refused — the tool can no
  longer be turned into a config or file-write primitive.
- **Chrome sanitization** (#1255, PR #1265): extension-controlled text is
  render-sanitized at every terminal chrome seam, not only at the main ones.
- **API key identity binding** (#1256, PR #1266): dotdir-stored API keys are
  bound to their endpoint identity, so a key collision across endpoints is
  detected instead of silently reused.
- **Tamper-evident session log** (#1259, PR #1267): every persisted event
  carries a hash chained to the previous entry (prevHash/hash), making
  post-hoc log edits detectable.
- **pathScopes bash deny** (#1260, PR #1268): bash joins the subagent
  pathScopes bare deny set — per-command containment is not soundly
  provable, so members under path scopes cannot run bash at all.
- **Credential/secret hygiene** (#1262, PRs #1269, #1270, #1271): keychain
  writes no longer pass the secret in process argv; short credential values
  are masked and miss-report temp files are unpredictable; model-supplied
  grep regexes are bounded (ReDoS) and the write/edit containment TOCTOU is
  closed.

### Changed

- **Model catalog refresh**: 19 metered prices updated; the two
  `claude-sonnet-4.5` context windows hold at the taught 1M after an
  upstream regression to 200k (declared windows are monotonic — ADR-0049,
  accepted via `acceptContextShrink`, see #1005 for the standing default).

## [0.59.2] - 2026-10-07

### Fixed

- **The right extension rail is anchored to the top of the transcript again**
  (#1251): the previous anchoring tied the rail's position to the composer's
  band, so the panel slid down instead of holding its place beside the
  transcript. The rail is once again laid out from the top of the transcript
  column, independent of composer height.

### Changed

- **Model catalog refresh**: 3 metered prices and 1 context window updated
  from the live OpenRouter/model.dev listings (routine drift, generator
  rebuilt).

## [0.59.1] - 2026-10-07

### Added

- **The stranded-data warning is live, actionable and resolvable from
  Home** (#1243, PR #1248): the warning row was permanent — the record
  lived as long as the old directory existed (a leftover `.DS_Store` kept
  it alive) and nothing in the product could retire it. The row is now
  cursor-selectable: `enter` opens a resolution overlay showing the
  summary (`onlyHere` / `sameSize` / `differing`), `k` acknowledges (a
  genuinely new stranded situation re-arms), `m` moves the logs that exist
  only in the old directory (byte-identical duplicates dropped, differing
  same-name logs untouched) and `d` sends session logs to the project
  trash and removes the rest, refusing sources outside
  `~/.moh/projects/` or equal to the live directory. The record is only
  reported while it describes a live situation; a Finder visit never
  re-arms the warning.

### Fixed

- **The rail band lives above the composer, reserved out of the volatile
  transcript** (PR #1244): the rail rode beside Chat's whole column, but
  only the volatile tail is laid out per frame — so any panel redraw moved
  it against the composer frame and a settling member squeezed the
  composer. The rail now reports its drawn height and Chat renders the
  band right-aligned directly above the composer separator: composer rows
  are budget-stable by construction, and below the composer's top line is
  forbidden ground. Sessions without the rail are byte-identical.
- **The team panel matches the adopted prototype** (PR #1246): selected
  roster row painted with the theme's selection background, focused panel
  keeps the accent border (the unselected ones dim when the rail has
  focus, instead of inverting), and the working glyph is `◐`. The
  selection painting lives in the client — the panel text stays verbatim,
  no UI dependency for `@moh/team`.

### Changed

- **The model catalog was regenerated** (release step): 3 prices moved —
  `moonshotai/kimi-k3` 0.62 → 0.50 and `~moonshotai/kimi-latest` 0.61 →
  0.49 down, `~z-ai/glm-flash-latest` 0.021 → 0.04 up. No context windows
  or reasoning flags moved; no issue and no context-window shrink.
  `PRICING_SNAPSHOT.version` follows the manifest, which declares 0.59.1.

## [0.59.0] - 2026-10-07

### Added

- **The team extension** (ADR-0074, #1218, PRs #1220, #1221, #1222, #1233,
  #1234, #1236, #1237, #1240): run several agents on one feature inside one
  session. The bundled `team` extension mounts behind its own enable
  consent — the question names the declared capabilities and the
  spawn-subagent sentence explicitly — and ships a `team` tool the lead
  model drives: it plans a feature into a task bag (plan, claim, complete
  as chrome events — #1223, PR #1234), composes the squad by task
  complexity (builder roles scoped with disjoint path globs, or a laneless
  reviewer — #1224, PR #1236) and steers members by writing into their
  sessions (PR #1233).
  The orchestration chapter and the manual bundled pass ride along (PR
  #1227). Members are real subagents under
  the ADR-0055 envelope — 10 per extension per session, no grandchildren —
  and the one stop aborts everything the composition started. The rail
  gains the team panel: live roster, member detail with steering and the
  team-scoped stop-all; composing a team auto-opens it (PRs #1238, #1240).
  Bundled
  out-of-the-box: no install, the consent is the only door.
- **Per-extension rail panels** (ADR-0062, #1218, PRs #1225, #1229): the
  rail distributes its panel slots dynamically across the extensions that
  declare `contribute-panels`, with a composer floor — the chat column
  shrinks beside the rail instead of the composer collapsing (the team
  panel's live roster and member detail ride it, #1225). Opened
  panels get an explicit focus model (`ctrl+p` toggles panel focus, `esc`
  returns to the composer, a permission modal always steals focus back —
  the ADR-0062 amendment).
- **Native spawn concurrency rises 3 → 5** (#1219, PR #1230): the default
  subagent concurrency matches the team composition's practical width; the
  stale "default 3" JSDoc went with it.
- **Team panel: steering from the member detail and a team-scoped
  stop-all** (#1226): in the rail panel's detail view every letter
  composes a steering draft and `enter` sends it to the member as its
  next turn; `x` in the roster stops everything the team spawned in one
  action — recorded as `orchestration_stopped` naming the team
  extension, lanes and worktrees untouched, the extension stays
  enabled. Panels that compose text may now consume the rail's scroll
  keys (extension apiVersion 1.18).

### Fixed

- **The stranded-data warning is no longer permanent and is resolvable
  from the home screen** (#1243): the warning row clears itself once the
  old directory stops holding project data (a leftover `.DS_Store` or
  `migration.log` no longer keeps it alive), and pressing enter on it opens
  a resolution overlay — move the unique session logs, delete the old
  directory (session logs to the project trash), or keep it and stop the
  warning with a durable acknowledgement.

- **A session migrating into a materialized-empty remote directory no
  longer strands its data** (#1217, PR #1228): `moh serve` migration moved
  uuid-named session data into a remote directory that only materializes
  on first remote access, so the data vanished from every listing until
  then. The migration now materializes the target directory first, and a
  stranded-data scan surfaces anything the older code already lost.

### Changed

- **The model catalog was regenerated** (release step): 20 prices moved —
  mostly down (`moonshotai/kimi-k3` 1.39 → 0.62, `moonshotai/kimi-k2.6`
  0.95 → 0.47), with `z-ai/glm-5.2` input rising sharply (0.019 → 0.171)
  and `deepseek/deepseek-v4-pro-0813` 0.4 → 0.66. No context windows or
  reasoning flags moved. One OpenRouter row was retired:
  `kwaipilot/kat-coder-pro-v2.5` left the listing with neither window nor
  metered rate and no declared source covering the variant — dropped with
  its audit trail on the #1005 precedent, the guard having refused the
  build (`context-window-lost` + `pricing-coverage-drop`) until the sidecar
  declared it. No issue and no context-window shrink.
  `PRICING_SNAPSHOT.version` follows the manifest, which declares 0.59.0.

## [0.58.2] - 2026-10-05

### Fixed

- **Lane `integrate`/`resolve` merge the worktree's live HEAD, not the
  stale registry ref** (#1210, PR #1214): both commands merged the
  auto-provisioned `moh/auto-<id>` branch even after the agent had created
  a semantic branch in the worktree at commit time — the auto branch sits
  at the base revision with zero commits, so the merge reported `landed`
  while the real work stayed orphaned: a silent no-op landing. The live
  branch is now resolved from the worktree, the registry's `branchRef`
  syncs to it (provenance), and the merge uses it; the registry ref
  remains the fallback when the worktree is missing, detached or points at
  an unknown branch, and still fails loudly when genuinely gone. The
  registry stays the source for status and labels; git stays the source
  for what is checked out.

### Changed

- **The model catalog was regenerated** (release step): 5 prices moved —
  `moonshotai/kimi-k3` 0.99 → 1.39 and `~moonshotai/kimi-latest` 0.66 →
  0.77 up, `z-ai/glm-5.2` 0.019 → 0.032, `z-ai/glm-5.3` 0.05 → 0.07,
  `deepseek/deepseek-v3.1-terminus` 0.27 → 0.30 slightly up. No context
  windows or reasoning flags moved; no issue and no context-window shrink.
  `PRICING_SNAPSHOT.version` follows the manifest, which declares 0.58.2.

## [0.58.1] - 2026-10-05

### Added

- **Row 2 speaks the lane from the first prompt** (PR #1211): a lane
  session's status row now shows the real project path (the main checkout,
  `~`-shortened, with a persistent `· lane` marker) instead of the worktree
  path, elides the opaque session-id branch tail to `moh/auto` while it is
  the auto-lane name, and renders the lane's task label in that space. A
  lane opened without a prompt is labeled by the first submitted prompt
  (one best-effort registry write through a new `onFirstSend` seam); once
  the agent creates a semantic branch, the label quiets and the branch
  name renders whole. Laneless sessions are byte-identical. `setLabel`
  collapses whitespace, so a multi-line prompt becomes one clean label.

### Fixed

- **A rejected Jev key is its own fact, not an outage** (#1207, PR
  #1209): every failure kind published the outage text, so a stale
  keychain credential (401 for a day, network fine) read `∅ jev offline`
  and the debugging went to the wrong seam. The client's status is now a
  three-state fact — healthy, outage (`∅ jev offline`), rejected key
  (`∅ jev key rejected`) — texts replace each other as the fact changes,
  and a host-seam refusal stays silent as #1162 requires. The chip learns
  `auth` and folds either failure into the summary, so `active` can no
  longer sit beside a rejection.
- **The Jev key migration never deletes a diverging plaintext key**
  (#1206, PR #1208): when the credential store already held a `typesafe`
  ref, the migration removed the legacy `typesafe.apiKey` from the config
  even when the two values differed — a working plaintext key plus a stale
  keychain item lost the only working copy, unrecoverable except by
  re-entry. A diverging key now stays in the file: the stored credential
  wins at runtime, `moh jev status` reports the lingering plaintext as
  legacy, and Settings is the user's reconciliation gesture. A migration
  never deletes a secret it did not save.
- **Declared-window teaching is gated on the refusal kind, with a
  plausibility bound** (#1199, PR #1203): any failure carrying a
  recognizable formula taught a window, and a hostile or broken upstream
  body could persist a bogus window that survives resume and feeds
  compaction, the fit guard and the fallback chain. Teaching now requires
  a real context refusal; a shipped-formula match at 400/422 is itself
  refusal evidence, read on the untruncated text (verbose bodies no longer
  lose the number to the 300-character cap); and a declared window smaller
  than the session's measured tokens plus reserve is refused as
  implausible, with one trace line. ADR-0049 amended.
- **The sanitize boundary closes outside the transcript** (#1200, PR
  #1204): render paths added since the v1/v2 fixes passed model-, tracker-,
  provider- or process-derived strings to Ink raw. The bundled Ink build
  strips cursor-movement CSI but deliberately preserves SGR and OSC
  sequences whole — so window-title hijack and arbitrary recoloring did
  reach the terminal. Frontier tracker strings, the SkillChooser header
  and command row, every toast text, and the TreePanel session label are
  now sanitized at the render boundary; the regression tests were
  committed red before the fix.

### Changed

- **Secret redaction covers long env-var key names and deep payloads**
  (audit-v3 RED-2, RED-1, PR #1205): structural keys matching `*_API_KEY`,
  `*_ACCESS_KEY`, `*_TOKEN` or any name containing `secret` —
  `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY` — are now masked wherever
  they appear, and the free-text assignment matcher accepts compound
  env-var names. Structure nested below the redaction walk's copy depth
  is scanned by a read-only deep pass (reach 6 + 100 levels) and masked
  when it holds a secret; the content-free `depth-cut` line in
  `secret-redaction-misses.log` now fires only past that reach.

### Fixed

- **Non-http(s) MCP server URLs are refused at config resolution**
  (audit-v3 MCP-1): the `mcpServers` schema accepts only `http(s)` URLs
  (`moh mcp add` rejects them at the door, a project `moh.json` fails to
  load), and the streamable-HTTP transport caps a response at 10 MB —
  JSON body and SSE stream alike — instead of buffering without bound.
- **`moh handoff pull` refuses when gh cannot say who is logged in**
  (audit-v3 CLI-1): a failed username lookup used to proceed without the
  per-persona author check; it now errors with the typed reason and
  points at `moh handoff import <file>`.
- **Documented the macOS keychain argv residual** (audit-v3 HOST-1):
  `moh secret --help` and the manual state that the keychain write hands
  the secret to the `security` CLI as an argument (briefly visible to a
  local `ps` poll) and steer high-paranoia hosts to
  `MOH_SECRET_STORE=file`.

## [0.58.0] - 2026-10-04

### Added

- **The `moh_docs` tool answers from the manual, not from memory**
  (ADR-0072, #1194, PR #1195): a binary-only user's agent answered a
  moh-capability question from trained memory and was confidently wrong —
  the correct answer shipped inside the very binary it ran. One built-in
  read-only tool, `moh_docs` (`index` / `read` / `search`), serves the
  bundled user manual: no filesystem, no network, content compiled into the
  binary so it can never drift from the installed version. No-match results
  instruct the model to say the manual doesn't cover the question, never to
  guess; citations use `Manual → <Title>`. The tool is permission
  `allow` by construction (a user rule `deny: moh_docs` still removes it),
  and the base prompt carries one sentence routing capability questions to
  it.
- **Base prompt v2** (ADR-0073, PR #1196): the shipped prompt went from
  ~260 tokens / 7 rules to ~550 tokens in six sections — Core behavior /
  Communicating / Code / Actions / Working / Security — every rule
  distilled from the Claude Code and Codex prompt corpora and compressed to
  moh's imperative style. New behavioral classes: outcome-first
  communication (one sentence at turn start, then silent work, complete
  final message), no scope creep with boundary-only validation and
  why-only comments, local-reversible actions free while shared or
  irreversible ones confirm, act when information suffices and recommend
  instead of surveying, and no OWASP-class vulnerabilities (fixed on
  sight). The ~290-token cost per model call is a constant, accepted
  because every rule is harness-universal.

### Changed

- **The README is a third of its size** (PRs #1190, #1192): duplicated
  sections merged, the vendor comparison and package tables dropped, and
  the manual linked instead. Features since the last refresh are named —
  development lanes, the extension platform, secret redaction, subagent
  orchestration, `onModelError` retry — plus the SDK story, the theme
  studio, handoff and local-only usage telemetry. The install one-liner
  and `scripts/install.sh` fetch from `main`, the stable branch (the two
  URL-fix commits had landed on main only); script behavior is unchanged
  and downloads still come from the latest GitHub Release.

### Internal

- **The `research-997/` working directory left the tree** (PR #1191): the
  #997 research notes are superseded by the landed ADR-0061–0071. Docs-only
  removal; no code touched.
- **The model catalog was regenerated** (release step): 4 prices moved —
  `deepseek/deepseek-v4-pro-0813` 0.85 → 0.55 and `z-ai/glm-5.2` 0.38 →
  0.05 down, `~z-ai/glm-latest` 0.05 → 0.08 up. No context windows or
  reasoning flags moved; no issue and no context-window shrink.
  `PRICING_SNAPSHOT.version` follows the manifest, which declares 0.58.0.

## [0.57.1] - 2026-10-04

### Added

- **The lanes modal scrolls and lanes can be removed** (PR #1185): the
  `/lanes` dialog no longer grows past the viewport — every lane renders
  as exactly one visual line (hard-truncated detail), the list scrolls
  inside a cursor-following window with `↑/↓ N more` indicators, and the
  footer names the focused lane's removal door. A verified registry gap
  closed with it: `moh lanes remove <lane-id> [--force]` deletes exactly
  one row, refusing a lane whose worktree still exists or whose status is
  not landed/abandoned — abandon stays the door for live git state. The
  TUI stays read-only per ADR-0060 and points at the CLI door; the CLI
  manual page is updated in the same change.

### Fixed

- **Keychain credential accounts are scoped to the assembly home**
  (#1178, PR #1184): the keychain is user-global while `home` is an
  assembly-level parameter, and accounts were keyed by the bare ref name —
  so a temporary home (a test, a lane) resolved the ambient user's real
  `typesafe` secret and activated Jev. The account now carries a digest of
  the assembly home (`sha256(home)[:16]:ref`): two homes on one machine can
  never read each other's secrets, and activation is always evaluated
  against the assembly's own home. Legacy bare-ref items are honored only
  from the ambient real home — the existing credential keeps working with
  no action.
- **`read` and `grep` name a bad path instead of surfacing raw errno**
  (#1186, PR #1186): reading a directory answered `EISDIR`, a missing path
  `ENOENT` — opaque to a model that must correct course. Both tools now
  name the miss (`path is a directory, not a file: X (open a file inside
  it, or grep it)` / `no such path: X`), and the tool runner classifies the
  wording as `errorKind: "not-found"` so telemetry separates wrong-path
  misses from real I/O errors.
- **The Jev chip never claims what the bar cannot back** (PR #1187, the
  #1182 follow-up): the bottom bar could render `jev offline ◈ jev active`
  at once. The outage now overrides the switches (`∅ jev offline` wins),
  and a healthy service with user opt-outs reads `◈ jev partial` — the
  user's own opt-outs are never hidden; `/jev` keeps the detail.

### Changed

- **The model catalog was regenerated** (release step): 2 prices moved
  (`deepseek/deepseek-v4-pro-0813` 0.33 → 0.85 input going up,
  `~moonshotai/kimi-latest` 0.6705 → 0.6518 down). No context windows or
  reasoning flags moved; no issue and no context-window shrink.
  `PRICING_SNAPSHOT.version` follows the manifest, which declares 0.57.1.

## [0.57.0] - 2026-10-04

### Added

- **The extension platform** (ADR-0061, PRs #1125, #1135, #1138, #1130): an
  extension ships as a directory with an `moh.extension.json` manifest —
  name, apiVersion, capabilities, contribution declarations — read once as
  the single authority; what the manifest does not declare does not exist
  for the extension. The enable consent names the declared capabilities
  (widening re-asks); `moh extension add|list|remove` is the
  immutable-source registry (no in-place upgrades: remove + re-add with
  explicit consent); an extension may contribute slash commands
  (`contribute-commands`, lowercase-only, reserved names guarded) and the
  headless command door waits for pending registrations before the first
  turn.
- **The host-tool seam and its scope family** (ADR-0064–0069, PRs #1168,
  #1169, #1170, #1173, #1179): `ctx.host.*` appears on the setup context
  only when the consent covers a declared scope — enforcement by absence.
  Five scopes: `path:<glob>` (one grant, whole read/write family,
  real-filesystem containment with symlinks resolved and per-component
  case handling), `host:<domain>` (exact https host, in-scope redirects,
  buffered responses), `credential:<name>` (keychain custody, ref-only
  access, host-side injection — the secret never crosses the seam),
  `tool:<name|*>` (invocation plus `contribute-tool`), and
  `endpoint:<ref>` (configured-endpoint calls through the Route). Refusals
  are typed results with one `host_refused` event, never exceptions; every
  performed operation records one `host_op` with the resolved path. One
  `checkScope` module authorizes every method; shipped scope grammars are
  enforced at install/scan time (ADR-0071, #1177) — a typo is a manifest
  error.
- **The spawn-subagent capability** (ADR-0053/0055, PR #1144, apiVersion
  1.13): `ctx.spawnSubagent` exists only when the slot is granted; the
  envelope is intersected at every spawn (10 children per extension per
  session, iteration ceiling, loud unknown-tool refusals), no grandchildren
  ever, and `ctx.subagentActivity` reads only children the extension
  spawned. The absolute prohibitions are enforced in core code: an
  extension can never mutate permission mode or rules, never write the
  consent store, never trigger reloads, never forge a chrome event —
  a hook runs marked, and privileged seams refuse with a typed error.
- **The extension rail, panels and overlays** (ADR-0062, #1132, PR #1140)
  and the **`/extensions` screen** (#1131, PR #1139): described in the
  0.56.0 section below, they ship for the first time in this release — the
  rail (closed by default, user-toggled, 4 panel slots, permission gate on
  every callback) and the read-only extension-state screen (versions,
  capabilities, commands, owned prompt sections, failures and refusals,
  derivable from the event log alone).
- **Notes modal: a real cursor, word wrap and inject-to-composer**
  (#1180, PR #1181): the editor was append-only with truncated long lines.
  It now tracks a cursor (line + grapheme-safe column, sharing the
  composer's helpers) with arrows/home/end, split and join at the cursor;
  rows word-wrap at the dialog border with correct scrolling; and `i` on a
  note hands its text to the composer prefill seam and closes the modal.
  Read failures degrade to a writable empty list with a visible hint.

### Fixed

- **Lanes resolve project config and git chrome to the real roots**
  (#1174, PR #1174): a lane worktree has no `moh.json` (gitignored), so
  every lane assembled the empty config — default provider, no mpm, the
  50-turn cap — and the TUI chrome showed the launch branch, never the
  lane's. `projectRootFor` now resolves a config-less worktree to its
  owning checkout (a worktree with its own config keeps it; `mpm.root`
  stays the worktree where the agent edits), and the chrome follows the
  real session cwd.
- **Six review findings from the spawn-capability review** (#1143, PR
  #1155): the semaphore transfers its permit to the head waiter so
  `#active` can no longer overshoot `maxConcurrency`; a bare `*` tool rule
  or override fails closed instead of granting everything; interleaved
  command invocations each keep their own overlay guard; the per-turn
  `extension_event` budget resets at turn dispatch; and a hook throwing
  after its timeout lands as one bounded `hook_late_error` record.

### Changed

- **Jev migrates onto the platform seams** (ADR-0071 phases F2/T7, PRs
  #1171, #1175): the TypeSafe key moves to the keychain-backed credential
  store with a one-time plaintext migration (activation is unchanged across
  the move; `moh jev status` reports a lingering plaintext key as legacy),
  and the network life crosses `ctx.host.fetch` with the bearer injected
  host-side — the key value never crosses the seam. Git reads move to a
  read-only `tool:git` builtin through the same checkpoint. `refused` is a
  deterministic failure kind, never retried.
- **The model catalog was regenerated** (release step): 24 prices moved in
  both directions — `deepseek/deepseek-v4-flash` 0.042 → 0.022 and
  `deepseek/deepseek-v4-pro-0813` 0.66 → 0.33 down, `z-ai/glm-5.3`
  0.22 → 1.4 and `moonshotai/kimi-k2.6` 0.43 → 0.95 up. No context windows
  or reasoning flags moved; no issue and no context-window shrink.
  `PRICING_SNAPSHOT.version` follows the manifest, which declares 0.57.0.

## [0.56.0] - 2026-10-01

- **Extension dependencies installer** (ADR-0070, #1166): an extension
  manifest may declare `"dependencies": { "zod": "3.23.8" }` — exact
  versions only; a range is a manifest validation error naming the
  package. moh installs the tree (direct and transitive) into
  `~/.moh/extension-deps/<extension>/` with its own `lock.json` carrying
  per-package SRI digests, re-verified at every install — drift is a
  loud error and refuses the load (`deps_install_failed`). No lifecycle
  script ever runs: a dependency declaring `install`/`postinstall`
  refuses with the package named (authors bundle). Install = download +
  digest verification + layout: the extension's own directory gets a
  `node_modules` link into its tree, so its imports resolve through
  nothing but its own dependencies. A deps change re-asks the consent,
  showing the deps by name and version; a refusal keeps the previously
  approved tree. Offline re-installs come from the moh-owned tarball
  cache only when its digest matches the lockfile. `moh extension
  remove` deletes the dependency directory; there is no shared store
  and no GC.

- **Extensions rail, panels and overlays** (ADR-0062, #1132, PR #1140,
  apiVersion 1.12): an extension with the `contribute-panels` grant registers one
  rail panel — arbitrary Ink rendering with a declared max-height, at
  most 4 visible across all extensions, a fifth refused visibly at load
  (`panel slot exhausted (4/4)`), no automatic eviction: collapse and
  reopen is manual from `/extensions`. The `contribute-overlays` grant
  registers a full-screen overlay opened by the extension's own command
  and closed with `Esc`. The rail is closed by default (the UI is
  byte-identical without extensions), user-toggled, and collapses to the
  footer on narrow terminals. Anything a panel callback does that the
  permission gate covers flows through the same gate — the click invokes,
  it never grants. Headless clients contribute nothing: panels and
  overlays are visible absence in `/extensions` (their names fold from
  `extension_loaded`), never a simulated rendering.

- **`/extensions` screen** (#1131, PR #1139): the TUI command opens a read-only
  extension-state snapshot — per enabled extension its version, source
  path (or "bundled"), declared capabilities, registered commands and the
  prompt sections it currently owns (ADR-0054); then the last failure
  with its reason, every refused registration, and the ignored duplicate
  copies. Headless callers keep the textual list, and the same state is
  derivable from the session's event log alone (`extensionsScreenState`
  fold in `@moh/core`, with `AgentSession.extensionLiveInfo()` supplying
  the runtime-only facts).

- **Prompt section replacement via `beforeModelCall`** (ADR-0054, #1129,
  PRs #1124, #1136, apiVersion 1.11): an extension with a per-section capability grant
  (`replace-prompt-section:<name>`) may replace one of the six data prompt
  sections (`environment`, `tools`, `skills`, `memory`, `session_state`,
  `mpm`) from the hook's return value; `null` hides. The core writes a
  provenance line at the head of a replaced section, refuses a second
  author per section visibly, and appends one `prompt_override` chrome
  event per composition change (`replaced` | `hidden` | `restored`) —
  never the words. The borrowed-runtime surface widens with
  `dispatchBeforeModelCall`, so a subagent child composes the parent's
  replacements with its own chrome.
- **Subagent spawn attribution and the orchestration stop** (ADR-0055,
  #1127, PRs #1133, #1134): every `subagent_spawn` event now records who asked — the model,
  or a named orchestration extension — and the limits actually applied to
  the child (tool allow-list, effective permission mode, iteration cap),
  so an orchestration's children are derivable from the log across
  restarts. New doors: `liveSubagents()` lists the children in flight and
  `stopSubagents()` is the one stop — it aborts every live child the
  session spawned and appends one `orchestration_stopped` chrome event,
  without touching the owner's own turn; `setSpawnRequester()` attributes
  subsequent spawns to an orchestration extension.

## [0.56.0] - 2026-10-01

### Added

- **Parallel development lanes** (ADR-0060, PR #1118): when several
  sessions work on one feature, each parallel session lands in its own
  isolated Git worktree on its own branch, so uncommitted changes never mix
  between sessions. Provisioning is lazy — it starts only when parallelism
  is observable (an active lane, or a sibling session touched the project
  in the last 10 minutes), and `lanes.auto: false` restores the pre-lane
  behavior entirely. A feature group groups the lanes of one base branch;
  spawns bind to lanes; integration walks a resumable conflict state
  (`moh lanes resolve`); stale lanes clean up. Surfaces: `moh lanes
  group|start|list|show|integrate|resolve|status|abandon|cleanup`, the
  `/lanes` modal (feature groups, labels, age, worktree health, cleanup
  door), and two new `lane_created`/`lane_transitioned` chrome events.
  Lane state is user data under `~/.moh/projects/<slug>/`; `node_modules`
  is symlinked from the checkout.
- **The project notes modal** (PR #1120): `ctrl+n` in chat and home opens a
  free-text notes surface scoped to the project and shared across
  sessions — user-only by design: never in the event log, never shown to
  the model. Notes live in `~/.moh/projects/<slug>/notes.jsonl` next to the
  session log, grep-able and hand-editable outside moh; writes are atomic
  and a malformed line is skipped, never fatal. List mode (pinned first,
  then most recently updated) with add/edit/pin/delete; the editor saves
  only on `ctrl+s`, `ctrl+z` restores the opening snapshot, and `esc` asks
  save/discard/stay when the draft changed. Side fix: Home no longer fires
  plain-letter shortcuts on ctrl chords it does not own.
- **The `pr` skill delivers its body via `--body-file`** (PR #1119): the
  skill's shape `gh pr create --body "$(cat <<'EOF' …)"` is broken on the
  macOS host shell (bash 3.2) — inside the substitution the body's own
  quotes still parse, so the first apostrophe in the prose dies with
  `unexpected EOF`. Measured over the session corpus: 169 calls used the
  shape, 113 carried an apostrophe, 81 were lost outright. The skill now
  teaches `--body-file -` with a `bash -n`-verified example, pinned as a
  declared deviation in `NOTICE.md` with a re-port guard test.

### Changed

- **The model catalog was regenerated** (release step): 6 prices moved —
  `tencent/hy3` 0.132 → 0.0825, `tencent/hy4-preview` 0.834 → 0.7506,
  `google/gemma-4-26b-a4b-it` 0.09 → 0.0765, `moonshotai/kimi-k3`
  0.6685 → 0.6635, with `~z-ai/glm-latest` 0.06 → 0.12 going up. No context
  windows or reasoning flags moved; no issue and no context-window shrink.
  `PRICING_SNAPSHOT.version` follows the manifest, which declares 0.56.0.

## [0.55.0] - 2026-10-01

### Added

- **Secrets are redacted from the session log, unconditionally**
  (ADR-0058, #1105, PRs #1106, #1107): every event payload now passes a
  redaction pass at the single write seam before it is persisted to the
  session JSONL. Secret-shaped keys are masked wherever they appear in the
  structure, and high-confidence secret patterns in free text (`sk-…`,
  `Bearer …`, `AKIA…`, `ghp_…`, `xoxb-…`, `api_key=`/`token=` parameters
  and assignments, PEM private key blocks) are replaced with a fixed
  `[redacted]` placeholder — no hash, no partial masking. There is no
  config key, flag or consent that disables it: the invariant lives in the
  log writer itself, on the owner's mandate that no secret is ever written
  in cleartext. The in-memory context is untouched, so in-session behavior
  never changes; resume, fork and compaction reconstruct from the
  already-redacted log, so a model resuming sees `[redacted]` where the
  original turn saw the secret. Precision beats recall — patterns must not
  corrupt legitimate code in tool output — and the corpus grows on
  evidence: a secret-shaped string that passed unmasked leaves one bounded,
  deduplicated diagnostic line in the user's moh dotdir, never its content.
  One shared redaction module serves the session store and the narrower
  seams (extension events, telemetry); existing logs are not rewritten,
  forward-only. The append hot path keeps a bounded scan, pinned by a
  performance ceiling test.
- **Retry-on-model-error seam (`onModelError`)** (ADR-0059, #1109, PR
  #1112): a provider call that fails with an error the Route does not
  already handle used to kill the turn — the human watched and recovered by
  hand. A new extension hook (apiVersion 1.10) is the mid-call decision
  point: it receives the serving ref, the normalized error kind and the
  sanitized message, and may propose an alternative `endpoint/model-id` to
  retry the failed call on. First hook to answer wins; a throwing hook is
  fail-open. Validation is the switch's own: the proposal goes through
  `AgentSession.switchModel`, so the #948 context-fit guard and the same
  registry apply, a fit refusal records one `switch_refused` and no retry,
  and a success records `model_switched` as any switch does. The retry is
  mid-turn by design — the failed call produced no serving turn, so
  re-reading the provider recovers instead of interrupting — and continues
  the same logical call: same `callId`, next attempt ordinal. One turn
  gets at most 4 consultations; an amended rule (#1111, PR #1114) refuses
  no-op proposals (same serving provider, no retry intent, no budget
  spend) so a lazy hook cannot burn the budget.
- **Jev routing retries a failed routed model with same-tier candidates**
  (#1110, PR #1113): the Jev routing extension uses the new seam to retry a
  failed routed model on up to 4 same-tier candidates — economic,
  balanced or powerful as labeled — gated by the endpoint cooldown and
  with owner-only refusal bookkeeping, so a flaky routed model no longer
  kills the turn when the pool has another option of the same tier.
- **The spawn line names the child, and the live panel shows more**
  (#1108, PR #1108): a spawned subagent's tool call rendered `used spawn`
  in vibe mode and raw argument JSON in dev mode; it now names the child
  (`spawn subagent · scout`, explicit name else preset) in both, failed or
  refused spawns keep their error block, malformed args degrade to the
  bare verb, and the subagent live panel tail grows from 4 to 8 rows.
- **Performance and task-outcome telemetry** (#1101, PR #1104): the event
  log records time-to-first-content per model call plus explicit,
  client-seamed task outcomes (`declareTask`, `recordVerification`,
  `recordTaskOutcome` on the session API) with bounded, redacted
  verification summaries. Read-only projections (`performanceByModel`,
  `taskReport`, `concurrencyReport`, `acceptedTaskFixture`) compute
  TTFC/latency percentiles, retry-vs-processing time, interrupted-call
  rate, and cost-per-accepted-task — computed only where acceptance
  evidence exists; unknown is never imputed and moh never infers success
  from model output. Documented in the extending chapter and the sessions
  manual page, with an explicit productivity disclaimer.
- **Provider billing and request-attempt telemetry** (#1099, PR #1102):
  every `model_call` now carries a per-attempt audit record — usage detail,
  endpoint identity and transport facts from a provider seam — plus an
  attempt-chain projection over session logs, so a retried or
  fallback-served call is one logical call with several attempts. A single
  event literal; surface restraint kept (no new TUI panes).
- **Quota and commercial usage state** (#1100, PR #1103): quota
  observations, episode boundaries and commercial declarations are
  recorded with cross-session rollup, declaration matching and redaction
  hardening, joining the #1099 attempt linkage when they rode a call.
- **The repository drops internal research artifacts** (#1096): the
  `research/` directory and its references left the tree; no product or
  docs surface changed.

### Changed

- **The model catalog was regenerated** (release step): 17 prices moved —
  several down sharply (`deepseek/deepseek-v4-pro` 0.78 → 0.21,
  `moonshotai/kimi-k3` 3.0 → 0.67, `z-ai/glm-5.3` 1.4 → 0.22) and a few up
  (`qwen/qwen3.8-27b` 0.02 → 0.42, `minimax/minimax-m1` 0.4 → 0.55). No
  context windows or reasoning flags moved; the report carries no issue
  and no context-window shrink. `PRICING_SNAPSHOT.version` follows the
  manifest, which declares 0.55.0.

## [0.54.0] - 2026-09-30

### Added

- **Provider connection failures are useful, readable and persistently
  diagnosable** (#1092, PR #1093): the onboarding probe now uses a bounded
  256-token budget, reports a concise summary plus structured detail (HTTP
  status, message, parameter, error type, request id and sanitized response
  body), and appends a redacted, bounded failure record to
  `<moh-home>/provider-test-failures.log`. The TUI wizard and `moh provider
  add` both pass the moh home, so failures are recorded even though
  onboarding happens before a session exists. Trailing-slash base URLs
  resolve consistently; the probe remains separate from normal provider
  requests. New additive `@moh/core` exports expose the diagnostic type,
  recorder and trace-file constants; no session event or permission-policy
  change.

### Changed

- **The model catalog was regenerated** (release step): four prices moved —
  `opencode-go/glm-5.1` 1.4 → 0.9646,
  `deepseek/deepseek-v4-pro` 0.95526 → 0.783,
  `deepseek/deepseek-v4-pro-0813` 1.32 → 0.66 and
  `qwen/qwen3.8-27b` 0.42 → 0.0249. No context windows or reasoning flags
  changed; generation reported no issues or shrinks. The manifest declares
  0.54.0.

## [0.53.2] - 2026-09-30

### Fixed

- **Permission prompts keep complete request details visible** (#1089): long
  command lines and generic tool arguments used to be truncated with an
  ellipsis, hiding the remainder from the person deciding whether to allow
  the call. The prompt now wraps the full details without dropping content;
  terminal-control sanitization and the permission decision itself are
  unchanged.

### Fixed

- **OpenAI onboarding uses the completion-token limit** (#1086, PR #1086):
  the API-key connection check sent `max_tokens: 1`, which current OpenAI
  models reject with `Unsupported parameter: max_tokens`. The built-in
  OpenAI path now sends `max_completion_tokens: 1`; other OpenAI-compatible
  providers keep their existing `max_tokens` payload.
- **OpenRouter's corrected context windows are reflected in the catalog**
  (#1004): OpenRouter now lists six models at 1,048,576 tokens, not the
  catalog's 1,310,720 — DeepSeek V4 Flash 0731, GLM 5.3 and GLM 5.3 Flash,
  plus their three `latest` aliases. The provider listing confirms the lower
  value; each sidecar now records the explicit correction and its rationale,
  so the guard remains active. No unrelated window is changed.

### Changed

- **The model catalog was regenerated** (release step): 17 prices moved;
  the six context-window corrections above were applied, with no reasoning
  flag changes, generation issues or other shrink. `PRICING_SNAPSHOT.version`
  follows the manifest, which declares 0.53.1.

### Internal

- **The project license is AGPL-3.0-or-later**: the project license and
  publishable package metadata now reflect AGPL-3.0-or-later. Third-party
  materials, including bundled skills, retain their original licenses and
  notices; no DCO or CLA was introduced.

## [0.53.0] - 2026-09-29

### Added

- **Six more bundled skills, reachable from the flow** (#1077, #1078):
  `research` (investigate a question and report findings), `handoff` (compact
  a conversation into a document a fresh agent continues from), `wait-what`
  (the correction valve when a reply did not land), `to-questionnaire` (a
  decision living in someone else's head becomes an async questionnaire),
  `retro` (session retrospective → environment improvements) and `pr` (a PR
  body: summary view, before/after evidence, merge danger). All six are
  verbatim MIT ports from `mattpocock/skills` (commit `d81f3a1`) with the
  deviations `NOTICE.md` records: `minMohVersion` added,
  `disable-model-invocation` dropped, the upstream `openai.yaml` sidecars not
  bundled, `research` carrying an inline fallback for hosts with no
  background agent, `wait-what` reading the glossary from `CONTEXT.md` first,
  and `retro`'s "Call the Skill tool" adapted to moh's read-the-SKILL.md
  mechanism. Installed is not reachable, so they were wired into the
  orchestration too: the `ask-moh` router sends a PR body to `/pr`, context
  hygiene to `/handoff` and `/retro`, on-ramps to `/to-questionnaire`, and
  lists `/wait-what` as the correction valve; `implement`'s close-out names
  `/code-review` → `/pr` → `/retro`; `grilling` deviates to
  `/to-questionnaire` when the decision sits with someone else; and
  `session-memory` states its division of labour with `/handoff`. The
  bundled roster is 25 skills.

### Changed

- **The model catalog was regenerated** (the release step): 11 prices moved,
  mostly down — `deepseek/deepseek-v4-pro-0813` 0.48 → 0.39,
  `z-ai/glm-5.1` 1.4 → 0.96, `qwen/qwen3.8-27b` 0.04 → 0.02,
  `~z-ai/glm-latest` 0.19 → 0.14 — with `z-ai/glm-5.2` 0.19 → 0.28 going up.
  No context windows and no reasoning flags moved, and the report carries no
  issue and no shrink. `PRICING_SNAPSHOT.version` follows the manifest, which
  declares 0.53.0.

### Documentation

- **The skills page names the six new skills** (#1077, #1078):
  `skills-and-workflow.md` listed ten bundled skills and ended with "and
  more", so the six ports above were reachable but invisible from the manual.
  The page names them and points at `/ask-moh` for the routing overview; the
  generated mirror in `docs/manual/` was regenerated with the script.

### Fixed

- **A failed `fetch` now says why, so the model stops reaching for
  `curl`** (#1079, PR #1080): a non-2xx used to discard the response entirely — the
  model saw `HTTP 403 for <url>` and nothing else. Across 1183 real fetch
  calls the failures were 269×404, 68×403 (57 of them GitHub's anonymous
  60-requests-per-hour quota, which `curl` beats only by carrying a token),
  33×422 and 6×504: the transport was never the culprit, the silence was.
  A failure now carries the status, a one-line verdict, the headers that
  carry the reason (`retry-after`, `x-ratelimit-*`, `www-authenticate`,
  `content-type`) and up to 2 KB of the server's own words — including
  GitHub's `API rate limit exceeded` and `No commit found for SHA: …`.
  A 5xx or a network error is retried once, waiting for `Retry-After` up
  to 10 seconds, while a 4xx and a cancelled turn are never retried.
  Redirects are followed up to 10 hops (was 3), each still resolved and
  re-pinned against DNS rebinding. Failures are classified in the session
  log as `rate-limited` or `transient` alongside `http-status`, so
  `moh usage tools` separates the server saying no from moh getting it
  wrong. The tool now also points local files at the `read` tool: 25 real
  calls had passed a `file://` URL to `fetch`.
- **A compiled binary starts a session with the browser enabled** (#1068, PR #1076):
  the browser modules were reached through a load that only resolves when
  moh runs from a source checkout, so every released single-file binary
  died at session assembly with `Cannot find module './browser'` as soon as
  the browser tool was enabled, on every platform, for every user who
  turned it on. The modules are now loaded the way the bundler can see
  them, which changes nothing about the tool itself: `browser.enabled`
  stays opt-in, a missing toolchain is still the visible
  `moh browser install` diagnostic and never a session failure, and the
  toolchain is still probed only when the tool is enabled. The compiled
  artifact gained a gate of its own in CI.
- **A heavy turn keeps its whole guardrail audit** (#1081, PR #1082): the
  pass audit accumulated every passing `bash` call's id — live and cache hits
  — and flushed them as one `appendEvent` at turn end. A turn with enough
  judged calls (~280) pushed the payload past ADR-0032's 8 KiB per-event cap,
  and the runtime drops an oversized payload **whole**, so one
  `extension_failed … payload exceeds the 8192 byte cap` line replaced the
  entire record — observed in real logs at 129/146/194 callIds, up to ~6.4 KB
  and one step from the cliff. The ids are now split into bounded
  `guardrail_passes` records at 4096 bytes, the same treatment #980 gave the
  injection aggregate, so every judged call stays named in the log whatever
  the turn's volume.

### Internal

- **The #922 truncation test asserts the invariant, not the phase**
  (#1075, PR #1083): the flake was a race, not load — `head + 3 gzip bytes +
  destroy()` can land after the response head is assembled (body-phase
  rejection) or while the response is still being built (request-phase
  rejection), the test accepted only the first, and its outer `await` was
  unguarded, so it failed with Bun's `ECONNRESET` instead of its own
  assertion. Both phases now settle into one outcome that is asserted, the
  mid-body server whose claim was unreachable was retired with its reason
  recorded, and 40 consecutive runs (whole-file and isolated) are green.

## [0.52.2] - 2026-09-29

### Fixed

- **A corrected context window no longer freezes the catalog** (#1004): the
  aggregators now report `openrouter/nvidia/nemotron-3.5-lightning` at
  262144 where the catalog said 1000000 — and they agree on it: the
  OpenRouter record, kilo's, and nano-gpt's TEE listing all declare the
  smaller number, while the row's `:free` twin still declares 1000000. The
  guard refused the build (`context-window-regression`) rather than ship the
  correction silently, and the row now declares the window on the
  established precedent, with the reason recorded next to it. The
  `:free` row is untouched.
- **The model catalog was regenerated** (the release step): 23 prices moved
  in both directions — `openrouter/openai/gpt-5.6-sol-pro` 2 → 4,
  `z-ai/glm-5.1` 0.96 → 1.4 and `z-ai/glm-5.2` 0.65 → 0.19,
  `qwen/qwen3.8-27b` 0.42 → 0.04, `~moonshotai/kimi-latest` 0.98 → 0.4 — plus
  the one accepted context-window correction above. No reasoning flags moved,
  no issue and no other shrink. `PRICING_SNAPSHOT.version` follows the
  manifest, which declares 0.52.2.

### Internal

- **The TUI behavioural gate leaves the pty** (ADR-0057, #1052, and the ten
  PRs that implemented it — #1053, #1063–#1067, #1069–#1072): `tui-pty`
  was the slowest and least reliable gate in the repository — 14 files, 30
  tests, 2 860 lines (680 of them a Python VT100 model), ~11m26s on CI
  against `tui-unit`'s ~2m37s, with verdicts that were a function of the
  host and of a presentation clock: the same test passed in isolation and
  failed intermittently inside its file, and *which* test failed changed run
  to run. The suite is now split by cost of observation. The transcript
  model is asserted as pure math with no clock; the in-process fake terminal
  (a fake tty plus the harness's physical-screen/scrollback model ported to
  TypeScript) carries the behavioural gate as the frames, wipes, layout and
  ask-user interaction families move off the pty; and what remains in
  `tui-pty` is the five-file process-boundary gate — startup, raw-mode keys,
  the alternate screen and its restore, `SIGWINCH`, byte-level `--no-color`,
  image protocols. A parity test runs one scripted scenario through both the
  simulator and a real PTY process and compares the physical screen and the
  scrollback row by row, so the model we own replaces a real terminal under
  test rather than an assumption. Measured: the PTY job falls from ~11m26s
  to ~1m31s. The reveal pacing became injectable (`reveal.ts`, a pure
  cursor that hosts can tune through a prop) so no assertion about which
  rows are painted at an instant depends on host speed, and the mock
  provider gained a deterministic mid-stream `hold` — the pty's wall-clock
  sampling is gone. The CI jobs now pin one exact Bun (1.4.2, previously
  `latest` while a local checkout ran 1.2.19, so "green on CI" and "green
  locally" were different claims), and `tui-pty` lost its retry path.
  No deletion landed before its replacement existed, each move was accepted
  by showing the new test red under a mutation that violates the old
  assertion, and the legacy `MOH_TYPEWRITER_*` knobs still work unchanged.
- **The extension and orchestration decisions are recorded** (#999, PR
  #1051, ADR-0054 through ADR-0056): prompt-section replacement (the six
  replaceable sections, one author per composition, the provenance line, the
  end-of-turn `prompt_override` event), the orchestration capability and its
  spawn envelope, and the hook timeouts with the required-check rule.
  Decision records only — no code in this release.

## [0.52.1] - 2026-09-28

### Fixed

- **The Settings sub-menus fit the terminal** (#1042, PR #1047): the nested
  Jev sub-menu rendered ~41 rows on a 24-row terminal — the parent list kept
  its full window underneath, the ten Jev rows rendered unwindowed, and the
  scope paragraph decided its wrapped height after the row budget was
  spent. A frame at `stdout.rows` sends Ink down its fullscreen path
  (`clearTerminal` + static reprint per render — the #622 flicker root
  cause). With a sub-menu open the parent list now steps aside entirely and
  the exact view is restored on close; the Jev rows use the same
  cursor-following window as every other sub-menu, with `↑/↓ N more`
  indicators; the paragraph is pre-wrapped and clipped with a visible
  truncation line instead of being silently squeezed.

- **The PTY harness fails loudly when a readiness wait expires** (#1045,
  PR #1048): `pump_until`'s bool return was dropped at the call site, so a
  readiness step whose needle never arrived burned its budget silently and
  the assertions ran over a state the step never verified — the CI red
  behind this issue was a mid-stream snapshot asserted to contain a marker
  that never came. The harness now raises on expiry (naming the needle and
  carrying the decoded buffer tail) and on a closed master; enforcing the
  contract exposed six test scripts whose waits could never hold, and all
  of them were rewritten against what their fixtures actually paint. All
  16 PTY files pass under a loaded batch runner with no retries.

- **The model catalog was regenerated** (the release step): 11 prices moved,
  mostly down (`deepseek/deepseek-v4-flash` 0.14 → 0.07 input, `z-ai/glm-5.1`
  1.4 → 0.96, `~z-ai/glm-latest` 0.365 → 0.18), with `z-ai/glm-5.3`
  0.365 → 1.4 going up. No context windows or reasoning flags changed, no
  issue and no context-window shrink. One OpenRouter free variant
  (`inclusionai/ling-3.0-flash-fin:free`) lost its aggregator record; the
  #1004 guard refused the build (`context-window-lost`) and the window is
  now declared by hand on the established precedent, with the paid siblings
  still aggregator-backed. `PRICING_SNAPSHOT.version` follows the manifest,
  which declares 0.52.1.

## [0.52.0] - 2026-09-28

### Added

- **The Jev guardrail has a switch of its own** (ADR-0052, #1041): a stored
  API key used to be the whole story — the guardrail was armed in every
  session and could only be disarmed for the one you had open. It now has the
  same two doors as the other six Jev use cases. `Guardrail` is a row in
  Settings → `Jev (TypeSafe)`, on unless you opted out, and
  `moh jev guardrail on|off` writes the same `typesafe.guardrail` flag (which
  `moh jev status` and `--json` now report); `/jev` keeps flipping it for the
  open session, in `yolo` too. A session assembled with the flag off judges no
  `bash` call at all and says so (`off in the config`), and the transcript
  line for a warm flip no longer invents a note — it states the same
  asymmetry as every other use case.

- **Every Jev row says what it does** (#1041): the ten rows of the Settings
  sub-menu and the seven of the `/jev` modal now carry one short description
  each, shown for the row under the cursor. The seven use-case lines come from
  a single map in `@moh/jev-guard`, so the two surfaces state the same thing
  in the same words; the three rows that are not use cases (API key, Status,
  Remove) describe themselves in the panel.

- **A session says which model serves its calls** (ADR-0050, #974, PR #1039): the
  model you selected and the stop that actually answers are two different
  things, and every surface now says so. Wherever a session states what it
  is working with — the system prompt's `Environment` block, the status
  bar, the transcript's serving record, the `/model` header, the fallback
  notice — the pair renders as `selected → serving` while a fallback is in
  play, and as the single reference otherwise, exactly as before. The prompt
  no longer tells the model it is running on a model that is not answering
  the call (the dead `Route:` line is gone), and the `/model` header keeps
  marking your selection — the thing a pick replaces — while showing what
  serves beside it.

- **Compaction can summarize deterministically** (#766, PR #1040,
  ADR-0051): `compaction.summarizer` in `moh.json` selects `"llm"` (the
  default — today's behavior, byte for byte) or `"deterministic"`. The
  deterministic strategy builds its digest from structured facts the runner
  now passes every summarizer — user requests, files read and modified,
  per-tool traffic, recent failures, the last assistant work — with no
  transcript parsing, and when that digest exceeds its 16k budget it degrades
  to the LLM summarizer explicitly instead of truncating silently; the
  `compaction` marker records which one served. Both forced paths (`/compact`
  and `moh compact`) use the same strategy, and the function seam
  (`CompactionOptions.summarizer`) still wins when both are given.

### Fixed

- **A subagent owns its own route** (ADR-0050, #974): a child used to
  borrow its parent's route object, so serving index, failure cooldowns and
  the recovery probe were shared — a fallback entered inside a child moved
  the parent's next call, with no record in the parent's transcript. A child
  now gets its own route, born from the pair its parent was in at spawn
  time, and keeps its own failures and recoveries. It does inherit the
  *knowledge*: an endpoint the parent found exhausted is skipped rather than
  re-probed, and its log opens with one `route_serving` record saying how it
  was born (which raises no fallback notice). Image capability and the
  compaction window now both follow the model that serves, so a fallback
  onto a text-only or smaller-window stop is handled instead of tripping
  over the selection's capabilities.

- **The corpus the next recognition formula is written from** (ADR-0049
  door one, #986): a refusal whose wording moh cannot read a window out
  of now leaves one line in `~/.moh/context-refusals.log` — date, endpoint
  type, model, a cleaned excerpt of the provider's own refusal text and a
  repeat count. Identical wording increments the count instead of
  duplicating, the file is capped, and it carries nothing of the
  conversation beyond the text the provider itself wrote.

### Changed

- **The declared window reaches the screen and the whole engine**
  (ADR-0049 door one, #986 — the behavior the 0.51.1 note describes): the
  refusal text is now read for the window it states *before* the
  300-character truncation, that number outranks the shipped catalog row
  for the refused model reference, and the arithmetic — compaction
  trigger, #949 tail cut ceiling, context-fit guard, fallback chain — all
  read it through one lookup. Wherever a window is shown for that
  reference the declared figure sits next to the catalog one
  (`131k declared · 1000k catalog`), including the footer gauge's
  denominator; every other model is unchanged. No probing, no inference:
  only a refusal teaches, one model reference at a time, and nothing is
  written to the catalog or to your config.

- **The endpoint's own listing outranks the shipped row** (ADR-0049 door
  two, #1032, PR #1037): the window an endpoint reports in its own cached
  model listing is now the one moh uses, and the lookup is keyed by the
  **endpoint** (kind + base URL), not the provider kind — so Zen is not Go
  and a recognised compat host has its own catalog. `fresh`, `cached` and
  `stale` listings all count; only a failed or unsupported one falls back to
  the shipped row, and the cache is read synchronously at assembly, so
  starting a session stays network-free. `catalogEntryFor` now resolves
  `openai-compat` hosts through their base URL's catalog, so Z.ai is no
  longer invisible to the arithmetic. The shipped Codex rows are corrected
  to the window the provider itself lists — `gpt-5.5` and the three
  `gpt-5.6-*` models go from 1,050,000 to **272,000** — because the
  aggregators describe the public consumption API, not the subscription
  backend moh serves.

- **The model catalog was regenerated** (the release step the flow now
  requires): 15 prices moved — both directions, with `deepseek/deepseek-v4-pro`
  0.35/0.70 → 0.96/1.91 and `z-ai/glm-5.3-flash` 0.045/0.14 → 0.15/0.5 going
  up while `z-ai/glm-5.1` and `~z-ai/glm-latest` moved too, and
  `opencode-go/minimax-m2.5` losing its cache-write rate — plus one context
  window that **grew** (`opencode-go/glm-5.1` 202752 → 204800). No reasoning
  flags moved, and the report carries no issue and no context-window shrink.
  `PRICING_SNAPSHOT.version` follows the manifest, which declares 0.52.0.

## [0.51.1] - 2026-09-27

### Changed

- **The declared context window outranks the catalog map** (ADR-0049,
  #986): the context window a provider declares in its own overflow refusal
  ("the maximum context length is 131072 tokens") is now recorded as the
  effective window for that model reference, for the session's lifetime.
  An unknown window abstains; a wrong one is trusted — so an over-claiming
  catalog silently accepts a conversation that exceeds the real limit, while
  an under-claiming one folds healthy work and blocks fits that are fine. A
  new `declared_window` chrome event records the correction, shown once in
  the transcript and headless log, never repeated for the same number. The
  ADR also closes the dangling core `context_length` ticket reference.

### Fixed

- **The lint correction round names measured probabilities** (#1014, PR
  #1028): the quality gate's correction turn named only the failing dimension
  — "completeness" — with nothing to aim at, and the worst moment to be
  vague was the final round, after which the gate hard-stops. The copy now
  carries measured probabilities from the verdict signals (`completeness
  (0.31)`), a dedicated transcript line for lint judgments shows the round
  and all dimensions (`conventions 0.80 · error handling 0.20 · completeness
  0.31`), and the zero-findings fallback no longer invents a `completeness`
  finding that was never measured below threshold.
- **Compaction reaches few-and-gigantic logs** (#949, PR #1029): the tail
  policy was structurally unreachable whenever the log held ≤ 10 user
  turns, no matter how large — so a session with three 80 k-token turns
  never compacted at all. The window now wins the tail: `tailTurns` is a
  preference, never a floor. One rule for both auto and forced paths: keep
  the last 10 whole turns, shrink from the oldest while the span exceeds
  25% of the window, protect the last turn while it fits `window − 8k`,
  and only when the last turn alone exceeds the ceiling does the cut land
  inside it — the largest legal suffix, or the last legal boundary when
  none fits. A structural refusal now appends a typed
  `compaction_skipped` chrome event (reason + numbers), never silent; the
  TUI stops promising `/compact` when a skip follows the newest marker, and
  `moh run` adds a hint after a `context_length` failure.
- **The event log is snapshot once per flush and detached on unmount**
  (#1031, PR #1033): `useProjected` copied the entire event log once per
  replayed event, per subscriber — opening a session of length L cost
  3L + 6 `history()` calls and (3L+6)·L copied entries, and the effect
  cleanup never returned the iterator, so listeners stayed alive after
  unmount: a component gone from the screen kept copying the whole log,
  unbounded, with one more leak per session switch. The consume loop now
  sets a dirty flag and flushes a single snapshot inside the ~33 ms
  coalescing window; the iterator is held explicitly and returned on
  cleanup (which removes the EventLog listener); a null-session reset
  stops the projection instead of leaving the old session's state on screen.
  Measured: a burst of 300 synchronous appends costs 2 snapshots instead of
  602; opening any session costs ≤ 8 snapshots regardless of length; a
  component that unmounts produces zero further snapshots.

## [0.51.0] - 2026-09-27

### Added

- **`ctrl+c` clears the composer** (#1009): a draft — pasted, multi-line, or
  recalled from history — could only be deleted by hand, because a single
  `ctrl+c` merely armed the exit toast. Over a non-empty composer the press
  now empties it as one undoable edit (`ctrl+z` brings the draft back) and
  resets the exit sequence, so clear → clear can never quit by accident. On
  an empty composer, and over a modal, a running turn or a focused chip,
  `ctrl+c` still means "press twice to exit".

### Changed

- **The empty composer's hint now points at the door** (#1010): it read
  `type… (shift+enter newline · ctrl+a/e line start/end)` — the line-editing
  keys — and now reads `/ask-moh - for everything you need (shift+enter ||
  ctrl+j newline)`, which is what a user staring at an empty prompt actually
  needs: the router over the workflow skills and the manual.
  `ctrl+a/e` still moves the cursor to the line start/end and stays in the
  `?` panel and the manual; it only leaves the hint. The hint stands where it
  fits one row, the narrower columns keep the short `type…` form.
- **The model catalog was regenerated** (#1005): 11 OpenRouter prices moved,
  including `z-ai/glm-5.3` 0.38/1.19 → 1.4/4.4,
  `~moonshotai/kimi-latest` 1.03/9.04 → 1/9, and
  `deepseek/deepseek-v4-pro` 0.37/0.74 → 0.35/0.70. The
  `deepseek-v4-pro-0813` output rate moved to 3.5, while the other changes
  cover DeepSeek, MiniMax, GLM and Kimi aliases. No context windows or
  reasoning flags changed, and the report has no issue or context-window
  shrink. The catalog contains 557 rows across 25 files; the drift compare
  is green again.
- **The release-time catalog check reports instead of failing, and the version
  contract is now enforced** (#1005, ADR-0046 amendment): the `catalog-check`
  job that runs at every tag was red by default — three of the last four tags
  failed it, and the two green ones were green only because someone
  regenerated the catalog minutes before tagging (measured upstream drift
  windows of ~4–5 hours). A signal that is red as a steady state distinguishes
  nothing, so at the tag the job now reports: the committed catalog's age
  against the tagged commit, how many of the 25 files moved upstream, and one
  line per changed row (price, context window, reasoning flag). It still never
  gates, and no flavour of drift turns it red: a rebuild its guards reject
  reports less — the age and the drifted files, with the row-level counts
  reading `--` — instead of failing. The drift compare that exits non-zero is
  untouched and moves from a weekly to a **daily** schedule, so staleness
  surfaces between releases instead of at the tag.
  Regenerating the catalog declaring the release being cut is now a documented
  step of the release flow, before the tag (`CONTRIBUTING.md`), and a new
  `version-check` job **does** gate publication: a release shipping a manifest
  that declares another version never becomes a draft Release, because
  `PRICING_SNAPSHOT.version` is a public export read from that manifest —
  v0.50.1 shipped a manifest declaring 0.50.0.

### Fixed

- **A catalog row can no longer ship without its context window** (#1004,
  ADR-0046 amendment): the `acceptContextShrink` escape hatch was tested
  against a value the build *derives*, so a row whose aggregator record
  disappeared produced `0` — which is exactly the "smaller window" test the
  hatch accepts. The loss passed with `issues: []`, and a model with no
  catalog window makes the context-fit guard abstain, so it would have been
  offered for a session of any size. The hatch now accepts a smaller number
  only; a window the build no longer produces fails generation as
  `context-window-lost`, and the seven rows that carried the hatch declare the
  window they already had.

## [0.50.3] - 2026-09-26

### Fixed

- **Live reasoning no longer floods native scrollback with blank rows**
  (#993, PRs #994, #1001): a provider may announce a reasoning part per stream chunk —
  measured live: 637 `reasoning_start` for one call, most of them carrying
  nothing — and the TUI's live buffer appended a paragraph break on every
  announcement. One empty part per chunk became one phantom blank row, and
  because the reasoning rows are promoted into native scrollback one per
  frame, a long thinking phase printed hundreds of empty rows: the reply was
  shoved out of the visible area and the finished reply sat in scrollback
  separated by large gaps (1303 of 1452 pushed rows blank at 100×24; 1270 of
  1389 in tmux at 149×40). The lifecycle's fold is now one rule in the core
  (`reasoning-parts.ts`, ADR-0048) — an announced part without text
  contributes nothing, kept parts join with one blank line — and the log and
  the live channel both apply it, so a client's live text is the persisted
  text plus the part still open, whatever shape the provider streams.
  Reasoning display was affected only with `showReasoning: true`. The wire
  dialect now coalesces one reasoning run into one announced part (#993):
  `mergeReasoning` no longer treats whitespace-only `content` deltas as the
  end of a run — several backends stream them alongside every reasoning
  chunk — so a run closes at the first content-bearing reply delta or tool
  call, with the complete continuation metadata, and the announcement rate
  no longer tracks the wire's padding. Deltas still stream live.

### Changed

- **The model catalog was regenerated before the tag, and one row was
  declared by hand**: the release-time catalog check flagged
  `openrouter.json` as drifted again, and the rebuild surfaced a real loss
  behind the drift. OpenRouter retired the free GLM 5.2 variant from its
  listing, so the row lost the aggregator record it carried three hours
  earlier and would have shipped with no context window at all — and the
  guard stayed silent, because that row's sidecar entry carried
  `acceptContextShrink`, which mutes the guard for the row it declares.
  `z-ai/glm-5.2:free` is now declared fully hand-maintained, pinning its
  window to the last value the aggregator gave (131072) instead of letting
  it disappear from the catalog. 4 prices changed, all on openrouter
  (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-pro-0813`,
  `~deepseek/deepseek-v4-flash-latest`), 0 context windows and 0 reasoning
  flags; no issue and no shrink in the generation report.
  `PRICING_SNAPSHOT.version` follows the manifest, which declares 0.50.3.

## [0.50.2] - 2026-09-25

### Added

- **Context fit: a switch can no longer land on a model that cannot
  hold the session** (#948, PR #985): every switch door — a routing extension's
  decision, `/model`, the CLI — now passes one wall. A target whose
  catalog window cannot hold the session's last measured input (with a
  fixed 8192-token reserve) is refused: nothing is applied, the current
  model stays in effect, and one visible `switch refused` line names
  the target, the measured tokens and the window — never a silent
  skip. The TUI `/model` picker asks first: a refused pick offers to
  compact now and pick again, or to keep browsing for a better-fitting
  model. The same predicate keeps the automatic fallback chain off
  endpoints whose preferred model cannot serve the session's context.

### Fixed

- **The anti-injection check no longer runs out of its per-turn event
  budget** (#980, PR #983): the check recorded one `jev_judgment` per
  judged item — one for the turn's input, one for *every* `fetch`/`browser`
  result — so an ordinary research turn reached the 50-events-per-turn cap
  on its own, and from there the transcript showed `✗ extension failed
  jev-guard` while the judgments that matter (a warning, a withheld page)
  were the first to be dropped. The passing tool-result judgments now land
  as ONE aggregate record per turn (`useCase: "injection_passes"`, with the
  call count and ids — "judged and passed" stays distinguishable from
  "never judged"), while a warning and a withheld result keep one record
  each, unsampled and now naming the call they judged. The input half is
  unchanged: one judgment per turn you send.
- **The event budget is the session's** (#981, PR #984): the ADR-0032
  per-turn cap (50 `appendEvent`s per extension per turn) was counted on the
  runtime, and a subagent child borrows its parent's runtime — so a child's
  judgments spent its parent's turn budget, the parent's own next `beginTurn`
  was the only thing that ever reset the child's counter, and the single
  cap-warning flag went to whichever session tripped it first: the parent
  could be disarmed for the rest of its turn with no `event_cap` line
  anywhere in its own log. Each session now has its own counter, its own
  one-warning-per-turn and its own reset at its own turn start, and the
  warning names the session whose budget it exhausted. The degraded footer
  overlay is the owner's own: another session's names itself where it is
  shown — its own transcript and log, plus one stderr line headless —
  instead of turning the owner's footer into a runtime-wide chip for a
  condition that is not the owner's. A borrowed session's budget is released
  when the child disposes.
- **The compaction cut guide works on long sessions again** (#979, PR
  #982): the Jev cut guide made one call and wrote one `jev_judgment`
  record per offered section, so on a long session — exactly the case
  compaction exists for — it failed twice over: the calls blew the 5 s
  hook window (the cut was discarded while the judge kept calling, ~13 s of
  judgments thrown away) and the per-section records exhausted the
  per-turn event cap, dropping the aggregate record that says what the cut
  did. The cut is now bounded on both axes: sections are judged
  largest-first, a few calls at a time, inside the window the hook is told
  about (`hookTimeoutMs`, plus the abort `signal` the runtime fires when
  it gives up — extension apiVersion 1.9), and everything judged lands in
  ONE aggregate record carrying every verdict, the ids actually dropped
  after the survival floor, and the outcome — `cut`, `floor`, `empty` or
  `discarded`, so a cut the window killed can no longer look like a
  judgment that found nothing. Sections left out (the judging budget, or
  the window) are declared in the record, never silently sampled. The
  transcript shows one line per compaction, and vibe mode keeps the two
  endings that need reading: a floor-reduced cut and a discarded one.

- **An announced router switch that could not be served is named at once**
  (#945, PR #987): the router decided a switch, the endpoint's fallback
  served a different model, and the session was told later — or never. The
  notice was emitted lazily at the next judged turn, a path that an
  override, a continuation message or a one-turn subagent never reaches. The
  core already recorded both sides at the moment it happened; nothing read
  it. The extension now reacts to that event in its hook: when the serving
  ref stops matching the decided target it emits one visible line
  (`jev · routing · continuing with X — Y could not serve`) and releases the
  expectation, so the router judges from the serving model on the next turn
  instead of freezing for the rest of the session. The lazy mismatch notice
  stays for the other cases it covers (a changed config, an id outside the
  tier map).

### Changed

- **The model catalog was regenerated from the aggregators** (#978, plus
  a second pass before the tag): the release-time catalog check flagged
  `openrouter.json` as drifted — the committed file no longer matched a
  rebuild, nor the hash recorded in `manifest.json`. Regenerated with the
  generator (ADR-0046: local and human-invoked; the release never
  regenerates). 7 prices changed in the final pass, all on openrouter
  (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-pro-0813`,
  `google/gemma-4-26b-a4b-it`, `nvidia/nemotron-3.5-lightning`,
  `tencent/hy3`, `~moonshotai/kimi-latest`) plus two context windows that
  grew (`nvidia/nemotron-3.5-lightning` 262144 → 1000000, `z-ai/glm-5.2:free`
  32768 → 131072) and 0 reasoning flags. No shrunk context window and no
  issue in the generation report. `PRICING_SNAPSHOT.version` follows the
  manifest, which declares 0.50.2.

## [0.50.1] - 2026-09-25

### Fixed

- **An opted-out endpoint stays out of the routing model pool** (#943, PR
  #968): an endpoint the user excluded from the fallback chain with
  `fallbackEligible: false` was still offered to the Jev router's model pool,
  so a switch could target a provider the user had explicitly taken out of
  automatic selection. The pool now applies the same exclusion the fallback
  chain does, through the shared eligibility predicate. `defaultModel` is not
  required for routability.

- **Router state is per session, and extension events follow their session**
  (#944, PR #969): a subagent child owns no runtime — it borrows its parent's
  — so the routing judge was one object for the parent and every child. Two
  children spawned in one parent turn supplied the two consecutive turns the
  hysteresis waits for, the router switched inside a child on turns that were
  never the parent's, wrote that switch into the parent's expectation, and the
  parent then reported an invented `mismatch` — after which routing was dead
  for the rest of the session. The child's `jev_judgment` line also landed in
  the parent's transcript. The extension contract gains an additive
  `apiVersion` 1.8: `beforeTurn`'s context carries `session: { id, owner }`,
  and the core scopes dispatches per session through an async-context store
  (not a mutable field — a parent turn runs its children concurrently). The
  judge keeps its state per session: the owner's in the durable store
  (hot-reload keeps streak and override), a borrower's in bounded memory. A
  child is born with the owner's pause in force and never inherits a manual
  override. On an older runtime the absent field reads as "one session", i.e.
  the previous behavior.

- **A streamed reply prints its blocks in reply order** (#970, PR #971): long
  replies arrived split across blocks, out of order, with a second `◆ moh`
  head in the middle of the text and sometimes a literal ` placeholder` line
  between two paragraphs. Two independent defects in the live prose
  promotion: a one-row markdown segment (a heading, a tight list item) was
  never eligible for Static promotion while the turn streamed, so a later
  segment promoted first and — `<Static>` being append-only — printed before
  it; and the fully-promoted slot placeholder kept the block's
  continuation/tight flags, rendering its own empty head. A live block now
  closes as soon as a later live block has rows and promotes all of its rows
  in one chunk.

- **An open paragraph stays reachable while it streams** (#972, PR #973): the
  closing paragraph of a reply was invisible while it formed — the open-tail
  branch only promoted rows of paragraphs a blank line had already closed in
  the block's own source, so a paragraph without one computed zero stable rows
  for its whole life. With the volatile area viewport-capped (#950, which
  keeps the newest rows), once the paragraph outgrew the budget its beginning
  was neither on screen nor in scrollback, and the whole paragraph printed in
  one burst at closure. The rule now lives next to the other row predicates
  and promotes the rows of an open block's inert prefix, minus the boundary
  row, and only where the prefix already renders that row identically.

## [0.50.0] - 2026-09-24

### Changed

- **moh owns its model catalog** (#959, ADR-0046): the 25 catalogs under
  `packages/core/src/model-catalogs/` are no longer a vendored pi-ai copy —
  they are generated by moh's own pipeline from two declared aggregators
  (models.dev primary, OpenRouter hole-filling) plus a hand-maintained
  `<provider>.overrides.json` sidecar per catalog, with per-row provenance in
  a committed manifest and a human-readable generation report. Coverage jumps
  from 461 to 525 aggregator-covered rows and the 97 id-only OpenCode rows
  (Zen and Go) gain context windows, capabilities and prices, which also
  fixes their missing context figures (#946). The cost estimates therefore
  move: prices and context windows are refreshed from the aggregators, and
  the OpenCode products are estimated from their own generated rows.
  `PRICING_SNAPSHOT` now reads the generation manifest, so `source` no longer
  claims a pi-ai provenance that stopped being true. `moh usage`,
  `moh sessions analyze` and the TUI quota modal follow each endpoint's
  declared **billing plan** (`billingPlan: "metered" | "subscription"` in an
  endpoint profile; absent = metered), which selects between a row's metered
  rate and its subscription-plan record — never inferred from a model name.
  A weekly CI job (plus PRs touching the catalog, plus the release pipeline at
  every tag) rebuilds and compares the catalogs without committing; generation
  stays local and human-invoked, and a release ships the last valid committed
  catalog. The release-time check is the recorded trigger to revisit the
  ownership decision (ADR-0046) — it never blocks a release.

### Fixed

- **A streaming reply no longer clears the screen** (#950, PR #962): a live
  prose block carried its rows in `renderedMarkdownRows` with an empty
  `lines`, so the transcript tail counted it as 2 rows however tall it was,
  and the oversized-block escape sliced the empty array — the cap never
  applied. The volatile region reached the terminal height and Ink took its
  fullscreen path (`clearTerminal` + full static reprint) every frame: 84–95
  clears and 0.7–2.2 MB per turn, scrollback wiped while the reply streamed.
  Row-chunk blocks are now measured and clipped by rendered rows, the footer
  budget is corrected (the blank row between status and action chips was
  missing, chat toasts are budgeted), and the reasoning window no longer
  re-asserts `reset: true` on every frame. Append-only Static emission is
  untouched.

- **A `context_length` error recovers instead of dead-ending** (#947, PR
  #963): two independent causes at the CompactionRunner seam. `lastMeasuredCall`
  read the newest `model_call` regardless of failure, so an overflow's
  `{0,0}` masked the real measurement — a failed call is not a measurement
  and is skipped. And `maybeCompact` returned early on any non-`done` status,
  so the turn that overflowed never armed the producer; a `context_length`
  error turn now arms the same single post-turn producer directly, bypassing
  the stale-measurement guard and the threshold — the provider's "does not
  fit" outranks our arithmetic. Still one producer, still post-turn, nothing
  compacts inline. The TUI names the next action (`/compact`, `/models`)
  instead of printing only the provider string. Known limit, out of scope: a
  session shorter than the compaction tail reports "nothing to compact" —
  switching model is the escape there.

- **The project identity is resolved before the tree mounts** (#939, PR
  #964): mounting the App outside the documented warm-up could crash Ink with
  "Should not already be working", taking every later mount in the process
  down with it. Resolving the identity synchronously spawns `git`, and under
  Bun a synchronous spawn pumps the event loop, letting a queued scheduler
  task re-enter the render mid-commit. A warm-up never removed the spawn, and
  a passive effect crashes too. The invariant moved into the boot:
  `prepareProjectIdentity` awaits the probe and pins it, every later
  resolution is memory-served, and the App mounts its tree only once the
  identity is prepared.

- **The fallback-level cursor no longer swallows key bursts** (#930, PR
  #965): the sub-menu moved its cursor from a closure read of state, so
  keystrokes arriving before Ink's next repaint recomputed from the same
  cursor and were dropped — three presses inside one commit window moved the
  cursor once. The sub-menu cursor and model-filter updates are functional
  now, which also covers a user holding an arrow key.

- **Two browser-toolchain installs in the same millisecond no longer
  collide** (#935 follow-up, PR #965): the promotion and staging directory
  names were stamped with `Date.now()`, so a fast runner could compute the
  same version directory twice and the second `renameSync` landed on the
  first install's directory (ENOTEMPTY, surfaced as a raw filesystem error
  instead of an installed toolchain); the `finally` could also delete the
  other install's staging tree. Stamps are unique now.

## [0.49.0] - 2026-09-24

### Added

- **The browser tool is turned on from Settings** (#934, ADR-0029
  amendment): enabling the native `browser` tool used to mean hand-editing
  `browser.enabled` in `moh.json`. Settings now carries a **Browser** row
  that states both halves of the truth — `off (this project) · toolchain
  ready` — and opens the guided setup: enable/disable **for that project**
  (activation is per project, the toolchain is user-level), headless or
  headful, the SSRF allowed-host list, and the install itself (headless
  shell first; the full Chromium build and Playwright's system
  dependencies stay explicit choices, and headful without the full build
  says so before you start a 500 MB download). Everything the settings
  write goes into that project's `moh.json` and preserves unrelated keys;
  a file that is not valid JSON is reported, never rewritten blind. The
  same modal is what the transcript warning's `install now`, `/browser`
  and ctrl+b open — one setup flow, not two. Because the tool registers
  when a session is assembled, a change re-assembles the open session for
  you; a change made from Home applies to the next session.

- **The browser tool installs itself** (#935, ADR-0029 amendment):
  enabling `browser` used to require `npm i -g playwright-core` plus a
  Chromium download — a contract that cannot hold for moh's prebuilt
  binaries, where a globally installed npm package is not resolvable
  unless the environment happens to expose it through `NODE_PATH`. The
  core now owns one cross-client toolchain seam: it resolves
  playwright-core through explicit, existence-gated paths (the project's
  own `node_modules` first — a hoisted workspace install still counts —
  then `~/.moh/browser-toolchain`), probes the package, the Chromium
  headless shell and the full build with versions and actionable reasons,
  and installs them with the Bun runtime embedded in moh: no npm, no
  system Bun, no sudo. Setup is headless-first (the ~200 MB shell a
  headless launch actually needs); the full build (~500 MB, headful) and
  Playwright's system dependencies are explicit options, never implicit.
  Installs are staged beside the root and promoted by a single atomic
  rename behind a lock file, so a failed or interrupted download never
  replaces a working toolchain and a second moh process is told to retry
  instead of racing.

- **The browser toolchain says what it needs** (#936, ADR-0029 amendment):
  an enabled browser whose toolchain is missing used to be silent — the
  TUI dropped the diagnostic and `moh run` printed nothing, so the tool
  simply never ran. The TUI now renders it as a warning with an `install
  now` action (the `install` chip, ctrl+b, `/browser`), stating the
  present in the footer and keeping every past diagnostic in the log as
  history; `moh run` prints one line on stderr (stdout stays pure JSONL,
  the exit code unchanged). The action opens a guided setup modal — the
  same surface Settings will open — that reports the toolchain truth and
  installs it headless-first: the full Chromium build and Playwright's
  system dependencies stay explicit choices. The new `moh browser
  status|install` gives the headless user the same door the core's own
  hint has been naming since #935.

## [0.48.0] - 2026-09-23

### Added

- **Linux arm64 is a first-class platform** (#916): the release now ships
  `moh-linux-arm64` (built and smoke-tested natively on the free
  `ubuntu-24.04-arm` runner) alongside the existing three binaries, and the
  install script maps `aarch64`/`arm64` onto it instead of refusing the host
  — which is what serves WSL on ARM64 Windows laptops. `moh update` learned
  the same platform name, so an arm64 install can update itself instead of
  reporting an unsupported platform.

- **A project under `/mnt` says so, in the TUI and in `moh run`** (#918,
  ADR-0044): a repository kept on a Windows drive reached through WSL
  (`/mnt/c`, `/mnt/d`, …) works, but every file operation crosses the 9P
  boundary into the Windows filesystem and is dramatically slower — nobody
  in the category mentions it. The session now resolves its project root
  once, at assembly, with the same realpath anchoring the permission spine
  uses (a symlink into `/mnt` counts, one out of it does not; the
  filesystem type is not sniffed). Under that condition the TUI footer
  carries one persistent, never-blocking hint line above the status rows —
  self-sufficient copy at every width, from the full explanation down to
  `⚠ /mnt is slow — use ~/projects` — and headless `moh run`
  prints one stderr line (stdout stays pure JSONL). It is always on, there
  is no config key to silence it, and it can never fail a session or turn
  into a turn error: it is environment information, not a validation. The
  distro-filesystem case renders exactly what it did before.

- **Windows install guidance in the README and the manual** (#918,
  ADR-0044): README §Install gained a `### Windows (via WSL)` subsection —
  no native Windows build, `wsl --install` first, the same single install
  command run *inside* the distro, and why projects belong in the Linux
  filesystem — and the manual's getting-started page explains what `/mnt`
  is, why it is slow, what to do about it, and that the advice is
  WSL-only.

### Changed

- **The installer asks before installing as root, and greets WSL users**
  (#917): running `install.sh` as root was silent before — it now always warns
  on stderr, and asks for confirmation on `/dev/tty` (never stdin, which under
  `curl … | sh` *is* the script) whenever a terminal is actually reachable;
  anything but `y` aborts with exit 1, while a non-interactive run (CI, a pipe,
  `setsid`) proceeds with the warning visible. There is no override variable —
  the no-TTY path is the escape hatch. On WSL (detected from
  `WSL_DISTRO_NAME`/`WSL_INTEROP`, with a `/proc/version` fallback) the script
  prints two informational lines: this Linux binary is the supported install,
  and projects belong in the distro filesystem because `/mnt/c` is dramatically
  slower — the same guidance the TUI footer carries for a `/mnt` project root.

- **The installer can no longer leave a half-written `moh`** (#917): the
  verified binary is staged inside the install directory and renamed within it,
  so the swap is atomic on that filesystem and a `$TMPDIR` on another one can
  no longer produce a truncated binary. A failing `--version` smoke test now
  runs *before* the existing install is touched: a binary that cannot execute
  (glibc on a musl distribution — Alpine, including Alpine WSL) aborts with a
  message naming the likely cause and leaves the working `moh` in place, where
  it previously replaced it and broke the command. The PATH hint names the file
  your shell actually reads — `~/.bashrc` for bash, `~/.zshrc` for zsh,
  `~/.profile` as the fallback — instead of always `~/.profile`.

 - 2026-09-23

### Added

- **A provider can be excluded from the fallback chain** (#919): the
  preferred-model screen could only clear a model, which dropped an endpoint
  from the chain as a side effect — "keep this provider out of the chain, but
  remember the model I chose for it" was not expressible. `x` in Settings →
  Fallback models now excludes the selected provider (or puts it back) while
  keeping its preferred model, and the row reads `✗ excluded`; `c` still
  clears the model itself, and the two controls are independent. CLI:
  `moh provider fallback <endpoint> --exclude`/`--include`, with
  `moh provider status` saying `(excluded from the chain)`. The core writes
  the ADR-0012 `fallbackEligible` flag on user-level endpoints, and
  re-including removes the key instead of writing `true`. The eligibility
  rule is genuinely one predicate now (`fallbackStopsFor` filters on
  `fallbackIneligibleReason`, the same one the screen shows).

- **The live model-list refresh reports its outcome** (#920, ADR-0045): a
  failed or skipped refresh used to be indistinguishable from an
  up-to-date list, which is how a stale Z.ai picker and a hidden ChatGPT
  model went unnoticed for months. Each endpoint's result is now explicit
  — refreshed, served from a cache (with its age), not refreshable, or
  unsupported (a provider with no listing route is static by design) —
  and `r` in the model picker states it. The background refresh stays
  quiet unless it would leave you without a list.

### Fixed

- **The live model list now covers every provider moh ships a catalog for**
  (#920, follow-up to #551): the augmentation reached 7 of the 24 provider
  kinds — for the rest the picker showed the vendored pi-ai snapshot and
  nothing ever refreshed it, while the fifteen openai-compatible profiles of
  #726 ship a *single* vendored model each. Every `<baseUrl>/models` route
  was probed and wired into one contract table: Z.ai (11 models live against
  7 shipped — the owner's own stale list), Kimi Code (its list lives under
  `/v1`, not at the `/models` that made it look absent), DeepSeek, Groq,
  Cerebras, NVIDIA NIM, Together, Fireworks, Hugging Face, Mistral, Moonshot,
  MiniMax, Qwen, Xiaomi MiMo, Vercel AI Gateway and Cloudflare AI Gateway.
  Baseten is the one provider with no verified route (its `/v1/models` is
  served by the website) and stays static, as a declared decision. A listing
  label now also reads `name`/`max_context_length`, the fields OpenRouter and
  Mistral use, instead of showing a raw id.
- **The ChatGPT/Codex listing no longer hides the newest models** (#920): the
  backend requires `client_version` and gates each model on its own
  `minimal_client_version`, so the old `0.0.0` default returned the
  0.153-era list — `gpt-6-sol` and `gpt-6-luna` (min 0.155.0) were invisible
  — and moh's own version would have returned an *empty* list. The listing
  now asks for the full catalog with a saturating client version, and a
  well-formed but empty list is classified as a failed fetch (degrading to
  the cache) instead of being read as an unrecognized shape.
- **An OpenCode model that only the live listing knows is routable** (#920):
  the Zen/Go endpoints carry a per-model wire in the shipped catalog, so a
  live-only id had none and the turn died with `provider kind "opencode" has
  no wire mapping` — after the switch had been accepted. The kind now has a
  verified default wire (both products serve every model over
  `/chat/completions`, probed with a live-only id and with a catalog entry
  whose per-model wire differs), so `grok-4.7`, `omen-alpha`, `deepseek-flash`
  and friends work instead of being dead picker rows.
- **The DNS-pinned `fetch` tool no longer hangs while reading a response
  body under Bun** (#922): the pinned path used undici's Fetch wrapper;
  under Bun 1.2.19 + undici 7.29.0 the response could settle while
  `text()`/`arrayBuffer()` never did (reproduced on both a corporate network
  and mobile tethering; unpinned `globalThis.fetch` stayed stable). The
  pinned transport now uses `node:http`/`node:https` with the already-verified
  address supplied through the socket lookup seam, preserving the original
  hostname for Host/TLS SNI and the #697 one-resolution guarantee. The
  regression test is hermetic: a fake hostname is pinned to a local listener
  50 times, so it tests the real transport without public DNS or network
  timing; the rebinding tests now separately pin single-shot resolution and
  per-redirect verification instead of succeeding through a blackholed IP.

### Changed

- **The live model-list refresh now says what it did** (ADR-0045, #920):
  `fetchLiveCatalogs` returns a status per endpoint instead of a bare list —
  refreshed, cached (with its age), stale (an expired cache kept while the
  refresh failed), unavailable (with the reason), or static by design for a
  provider with no listing route. The background refresh stays quiet unless
  it would leave you without a list; `r` in the model picker always reports,
  and the Settings model picker states what its list is.

## [0.46.0] - 2026-09-23
### Added

- **Home session pins** (#904): `ctrl+p` pins/unpins the selected session row
  (pertinent banner included); pinned rows float to the top of the Home list
  (then by mtime) with a 📌 marker. The pin is a chrome event
  (`session_pinned`) appended by the exported `setSessionPinned`, so resume,
  fork and compaction inherit it, and `SessionSummary.pinned` carries it to
  clients. Rename and delete move from `r`/`d` to `ctrl+r`/`ctrl+d` (→ still
  enters the rename edit), and the manual's Home table follows.

- **Logo intro on the Home screen** (#906): a randomized ASCII animation of
  the logo plays before the content shows (~2.8s; any keystroke skips it) and
  settles into the static banner's exact spot, so the layout never shifts.
  Eight styles are picked per mount (scatter, typewriter, glitch, slide,
  rain, unveil, pulse, wave) and colors ride the active theme. Transient
  chrome (update notice, banners) stays off the animation.

- **Per-endpoint preferred model for the fallback chain** (#906, ADR-0012):
  the chain was automatic but the choice was not addressable. The endpoint
  profile's `defaultModel` is now writable — project endpoints in moh.json,
  user-level ones in `~/.moh/config` (the settings panel can now write it,
  it was display-only). Settings gains a "Fallback models" row per endpoint
  showing the model it would serve (📌) and, when it cannot be a stop, why;
  `c` clears the preference and drops the endpoint from the chain. CLI:
  `moh provider fallback <endpoint> [model]` (`--clear` removes it), and
  `moh provider status` prints each endpoint's preferred model. The
  eligibility rule is one predicate (`fallbackIneligibleReason`) shared by
  the chain builder and the UI, so the screen can never disagree with the
  route.

### Changed

- **Home startup paints before scanning** (#906): the Home screen renders
  first and session-log scanning runs in a deferred effect after the intro
  settles, with a loading state — on large session stores the first frame no
  longer waits on parsing. The "last 7 days: N tok · top <model>" usage line
  is gone from Home (it also cost an `aggregateTelemetry` scan at startup);
  token rollups stay in `moh usage`.

### Fixed

- **zai GLM reasoning is rendered again** (#905): Z.ai GLM models stream
  reasoning as `delta.reasoning_content` (DeepSeek/Z.AI lineage), which the
  stock openai-chat adapter strips. zai targets now route through the
  reasoning-aware openai-compat wrapper via the existing compat flag — the
  same pattern as the opencode-go fix — restoring reasoning that was lost
  when switching from an openai-compat endpoint to the built-in zai
  provider.

## [0.45.1] - 2026-09-22
### Fixed

- **A thinking turn with no reasoning stays valid after a tool call**
  (#895, PR #901): the openai-compat dialect now pads an assistant message
  that still lacks `reasoning_content` with an empty string — but only when
  a thinking effort is selected. Live measurement against opencode-go
  showed the upstream enforces the round-trip requirement
  nondeterministically: identical post-tool payloads failed 4/55 times
  without the field and never with it, and turns where the model produced no
  reasoning were left bare by v0.45.0's persisted-reasoning re-injection
  alone. Thinking-off requests gain no new fields.

## [0.45.0] - 2026-09-22
### Added

- **Wizard: `c` copies the authorize URL** (PR #897): on the provider login
  screen the `c` binding copies the full authorization URL to the clipboard
  (extracted from the raw log, never the truncated rendering). A clipboard
  failure is reported visibly and the URL stays on screen as a manual
  fallback.

### Fixed

- **Bare thinking-capable chat entries route to the reasoning-aware
  wrapper** (#895, PR #896): catalog entries that declare
  `requiresReasoningContentOnAssistantMessages` are now honored when the
  thinking format is absent — previously only explicit thinking formats
  reached the wrapper, so the first tool call after a thinking turn failed
  with "thinking mode requires reasoning_content" on opencode-go. Mapping
  of multi-turn reasoning indexes and thinking-off behavior are pinned by
  tests.

- **The tracker probe survives a directory without git** (PR #898): opening
  moh in a box without a git repository no longer throws from the Frontier
  tracker probe; the tracker degrades to its no-repo state.

## [0.44.0] - 2026-09-21
### Added

- **Scoped fork** (#768, PR #884): forks are no longer whole-tree only.
  `/fork [tree|branch]` in the TUI and `moh run --session --fork
  --fork-scope branch|tree` in the CLI choose between the classic full
  projection and a branch-scoped one: only the current turn's lineage is
  replayed, the rest of the tree is not carried over. The projection is
  implemented in the core (branchProjection, type-safe narrow writes), the
  fork stays a chrome-level operation, and the choice is documented in the
  manual and pinned by ADR-0043.

- **Theme catalog expansion and two-column picker** (PRs #886, #887): ten
  new built-in themes — retro machines (C64, Amiga Workbench 1.3), cinematic
  darks (TRON, Blade Runner, Iron Man, Star Wars), a light pair (Daylight,
  Daylight Frost) and two wildcards — all contrast-checked at ≥3:1; the
  theme picker renders in two columns with `[s]`/`[u]` source labels
  (builtin vs user), guarding color-free theme projections.

### Fixed

- **Reply body painted with the theme's fg token** (PR #885): plain runs of
  an assistant reply no longer fall back to the terminal default color —
  they use the theme's `fg`, so themes with a non-default background render
  the reply body in the intended color.

## [0.43.0] - 2026-09-21
### Added

- **`NO_COLOR` is honoured by the TUI** (#880): with the variable set
  (present and non-empty) no color code reaches the terminal — through Ink
  or through the escapes moh writes itself (markdown, the quota table, the
  preview box) — while bold/dim emphasis stays. `moh update` already
  respected it; the session UI now agrees. An empty value means "not set",
  per the convention.

- **Bottom-bar status rows** (#876): row 2's tail is right-aligned in every
  combination — it rendered flush left whenever no yolo banner or update
  notice was up — every permission mode now speaks in the row's left slot
  (`◌ Normal`, `◐ Auto-Accept`, `⚠ YOLO — unrestricted tools`, the text
  dropped by width class), and row 1 gains a `◈ jev` chip summarizing the
  extension's seven use cases (`active` / `off` / `inert`), silent when Jev
  is not registered or has not answered. Row 1's braille cycle is replaced
  by a seven-cell liveness scanner — one lit segment sweeping left→right and
  back with a decaying trail (ADR-0042) — in every session.

### Fixed

- **The volatile region no longer exceeds the terminal height** (#874, PR
  #877): with long sessions the open turn, composer and ask_user box could
  overflow the viewport, flipping Ink into its fullscreen path
  (`clearTerminal` + full static reprint every frame — scrollback wiped,
  ~22 Hz flicker). The volatile region is now capped below the terminal
  height, so the fullscreen repaint path never engages.

- **opencode-go openai-chat wire repaired** (#873, PR #875): tool arguments
  were double-encoded and `reasoning_content` dropped on the Go endpoint's
  openai-chat wire; both are fixed, and 5xx responses retry with a deeper
  backoff.

## [0.42.0] - 2026-09-20
### Added

- **Skill slash arguments** (#765, PR #866): workflow skill aliases accept
  positional `$1..$9`/`$@` and named `${name:-default}` placeholders
  (supplied as `key=value` tokens); substitution happens on the ADR-0011
  skill-prompt path only, and unresolved placeholders flow to the composer
  as a zero-stress pre-fill — never an error, never silent removal.

- **Routing stays inside the declared tier when the target cannot serve**
  (#868, PR #870): when the classified tier's target endpoint is exhausted
  or cooling down, the router rotates within the same classified tier
  across active endpoints instead of jumping classes; an explicitly
  declared `routingPool` in moh.json widens the rotation on purpose. A
  skipped switch is an explicit, visible outcome: the staying model is
  named and the exhausted endpoint stays visible in vibe mode, and
  `/routing` surfaces the declared pool.

- **Guardrail publish-workflow rubric and visible yolo line** (#867, PR
  #869): publishing to the user's own tracker/remote (gh issue/pr
  create/comment/edit, git push, label edits) is ordinary development
  workflow, not exfiltration; `--public` gists and other people's repos
  stay exfiltration. An exfiltration deny contradicted by high `in_scope`
  degrades to ask in full mode and passes in yolo with a visible one-line
  note; destructive and risk-level denies are never softened, and the
  destructive rubric no longer flags deleting a scratch file the session
  itself created.

## [0.41.0] - 2026-09-20

### Added

- **The Jev guardrail's judgment records its verdict** (#843): every
  `jev_judgment` for the bash guardrail now carries `decision`
  (`pass`/`ask`/`deny`) and, on an ask or deny, the key dimension and
  probability the verdict was based on — a complete audit record.
- **Cache hits are recorded too** (#848): a repeated identical bash call
  leaves its own `jev_judgment`, marked `cached: true` and carrying the
  cached verdict with no fabricated model/latency/usage fields — the
  "every judgment is recorded, unsampled" promise holds unscoped
  (owner decision: option A, answered in the PR).
- **`shift+tab` rotates the permission mode** (#849): `normal →
  auto-accept → yolo → normal`, live from the next tool decision —
  including entering and leaving yolo mid-session, which was impossible
  (the mode was frozen at session construction and `--yolo` was
  launch-only). The session appends a `session_mode` event on every
  change, so resume, replay and the Jev guardrail's lethal-only
  narrowing follow the live mode; the `⚠ YOLO` banner appears and
  disappears with it (ADR-0040).
- **The quality gate's judged set is scoped to repository code** (#851):
  paths outside the work tree, files the task never successfully
  produced and calls that failed or were refused never enter the diff;
  a diff with no repository code is not scored with the code rubric;
  the correction text names the judged paths. A task that changed
  nothing in the repo can no longer spend both correction cycles on an
  unsolvable demand.
- **An empty completion is a failed call, and the fallback chain
  fires** (#853): a provider call returning no content, no tool calls
  and no usage was accepted as a successful turn (`usage {0,0}`,
  `done`, no error), so the ADR-0012 fallback chain never engaged. It
  is now classified as a new `empty_completion` ProviderError: the
  chain walks to the next viable target (15-minute cooldown on the
  empty one), and with the chain exhausted the turn ends with a visible
  classified error naming the endpoint that produced nothing — never a
  silent empty `done`.

### Changed

- **The transcript shows only notable guardrail outcomes** (#843): an ask
  or a deny renders one `jev · guardrail · <verdict> (<dimension> 0.42)`
  line; a pass renders none — the log keeps every record, only the
  projection changes. Old sessions without a recorded verdict keep their
  previous line on replay.
- **Vibe mode keeps only the Jev lines that earn their keep** (#845):
  guardrail passes, routing stays, classification and rerank records no
  longer render in vibe mode; anti-injection verdicts that changed what
  the user saw or sent, guardrail asks/denies, a routing switch or
  override, a quality-gate correction, a real skill suggestion and the
  use-case control lines survive. Dev mode is byte-for-byte unchanged;
  the event log is untouched in both modes.
- **A tool-heavy turn no longer exhausts the event cap** (#846): passing
  guardrail judgments aggregate into one per-turn record instead of one
  per bash call (the volume that made the 50-event cap reachable); when
  the cap *is* hit, the degraded state is visible for the rest of the
  turn (footer status, headless stderr), a sentinel record marks the
  skipped judgments, and every judgment made below the cap stays in the
  log.
- **The guardrail can be switched off in yolo** (#850, ADR-0041): the
  ratified refusal is reversed — a full `off` is honoured, recorded and
  visible, stays off across mode changes in the session, and `on`
  restores yolo's lethal-checks narrowing. No more yolo session stuck
  on an unapprovable veto.
- **The router never downgrades on a continuation message** (#852): a
  bare "procedi" no longer satisfies the tier/streak condition and
  moves the model mid-task; a switch never targets an endpoint in a
  known failure cooldown, and the manual states what a continuation
  message may and may not do to the serving model.
- **The README's demo slot is filled**: it pointed at
  `docs/assets/demo.gif`, which did not exist, so the README rendered a
  broken image. The GIF shows one full turn of the real TUI — its layout,
  glyphs, block grammar and Tokyo Night palette — including a permission
  prompt being raised and answered before a tool runs.

### Fixed

- **The routing mismatch notice renders a readable line** (#847):
  `jev · routing · serving <current>, router picked <expected>` instead
  of the bare `◈ jev · routing`; malformed payloads degrade gracefully,
  unknown kinds keep the bare fallback.

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

[Unreleased]: https://github.com/Marco-Cricchio/moh/compare/v0.61.0...develop
[0.61.0]: https://github.com/Marco-Cricchio/moh/compare/v0.60.0...v0.61.0
[0.60.0]: https://github.com/Marco-Cricchio/moh/compare/v0.59.3...v0.60.0
[0.59.3]: https://github.com/Marco-Cricchio/moh/compare/v0.59.2...v0.59.3
[0.59.2]: https://github.com/Marco-Cricchio/moh/compare/v0.59.1...v0.59.2
[0.59.1]: https://github.com/Marco-Cricchio/moh/compare/v0.59.0...v0.59.1
[0.59.0]: https://github.com/Marco-Cricchio/moh/compare/v0.58.2...v0.59.0
[0.58.2]: https://github.com/Marco-Cricchio/moh/compare/v0.58.1...v0.58.2
[0.58.1]: https://github.com/Marco-Cricchio/moh/compare/v0.58.0...v0.58.1
[0.58.0]: https://github.com/Marco-Cricchio/moh/compare/v0.57.1...v0.58.0
[0.57.1]: https://github.com/Marco-Cricchio/moh/compare/v0.57.0...v0.57.1
[0.57.0]: https://github.com/Marco-Cricchio/moh/compare/v0.56.0...v0.57.0
[0.56.0]: https://github.com/Marco-Cricchio/moh/compare/v0.55.0...v0.56.0
[0.55.0]: https://github.com/Marco-Cricchio/moh/compare/v0.54.0...v0.55.0
[0.54.0]: https://github.com/Marco-Cricchio/moh/compare/v0.53.2...v0.54.0
[0.53.2]: https://github.com/Marco-Cricchio/moh/compare/v0.53.1...v0.53.2
[0.53.1]: https://github.com/Marco-Cricchio/moh/compare/v0.53.0...v0.53.1
[0.53.0]: https://github.com/Marco-Cricchio/moh/compare/v0.52.2...v0.53.0
[0.52.2]: https://github.com/Marco-Cricchio/moh/compare/v0.52.1...v0.52.2
[0.52.1]: https://github.com/Marco-Cricchio/moh/compare/v0.52.0...v0.52.1
[0.52.0]: https://github.com/Marco-Cricchio/moh/compare/v0.51.1...v0.52.0
[0.51.1]: https://github.com/Marco-Cricchio/moh/compare/v0.51.0...v0.51.1
[0.51.0]: https://github.com/Marco-Cricchio/moh/compare/v0.50.3...v0.51.0
[0.50.3]: https://github.com/Marco-Cricchio/moh/compare/v0.50.2...v0.50.3
[0.50.2]: https://github.com/Marco-Cricchio/moh/compare/v0.50.1...v0.50.2
[0.50.1]: https://github.com/Marco-Cricchio/moh/compare/v0.50.0...v0.50.1
[0.50.0]: https://github.com/Marco-Cricchio/moh/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/Marco-Cricchio/moh/compare/v0.48.0...v0.49.0
[0.48.0]: https://github.com/Marco-Cricchio/moh/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/Marco-Cricchio/moh/compare/v0.46.0...v0.47.0
[0.46.0]: https://github.com/Marco-Cricchio/moh/compare/v0.45.1...v0.46.0
[0.45.1]: https://github.com/Marco-Cricchio/moh/compare/v0.45.0...v0.45.1
[0.45.0]: https://github.com/Marco-Cricchio/moh/compare/v0.44.0...v0.45.0
[0.44.0]: https://github.com/Marco-Cricchio/moh/compare/v0.43.0...v0.44.0
[0.43.0]: https://github.com/Marco-Cricchio/moh/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/Marco-Cricchio/moh/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/Marco-Cricchio/moh/compare/v0.40.0...v0.41.0
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