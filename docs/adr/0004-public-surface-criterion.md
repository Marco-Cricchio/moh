# 0004 — Public-surface criterion for @moh/core

Date: 2026-08-24 · Status: accepted · Refs: ticket #98, `docs/principles.md` (1, 6)

## Context

`packages/core/src/index.ts` re-exported ~90 symbols — including test-only
providers (`EchoProvider`), memory internals exported for test convenience,
MCP plumbing constants, and workflow/tracker tooling — and additionally
*defined* `SessionConfig`/`PermissionsConfig`, which internal `session/`
modules then imported from the barrel (a layering smell: `session/*`
importing from `../index`). The package is not published (v0.1.0,
workspace-only): at first publish every export becomes a de-facto perpetual
contract. Before publish, closing doors is free; after, each removal is a
breaking change.

## Decision

**The official entrance exports what a client or extension needs to live;
everything else is internal; re-opening a door is an explicit decision.**

Mechanical keep-criterion: a symbol stays in `index.ts` only if
`@moh/tui`, `@moh/cli`, `@moh/extension`, or a user-facing config surface
touches it today. Everything else becomes internal: tests import directly
from the defining module. Removing a symbol is allowed now; adding one back
after this ADR is an explicit, recorded decision.

Accompanying moves:

- `SessionConfig`/`PermissionsConfig` are defined in `session/config.ts`
  (next to the session they configure) and re-exported from the index.
  No internal module imports from the barrel anymore.
- `EchoProvider` leaves the public surface (tests import it directly).
  `MockProvider` stays: the TUI factory uses it as the demo/fallback
  provider, and the CLI uses it for `--cassette` runs.
- One curated entry; no subpath exports (e.g. `@moh/core/testing`) — those
  can be added deliberately later if a real external need appears.

### Keep-list

Clients (TUI/CLI/extension) + config surface, with the reason each stayed:

- **Session entry**: `createSession`, `AgentSession` (type), `SessionConfig`,
  `PermissionsConfig`, and every type `SessionConfig` references:
  `ProviderRegistry`, `PromptComposer`, `SkillIndexEntry`, `ExtensionRuntime`,
  `McpRuntimeOptions`, `SubagentOptions`, `MemoryOptions`, `PermissionRule`,
  `PermissionOverrides`, `Provider`, `Tool`, `AgentEvent`, `AskUserQuestion`,
  `AskUserResult`.
- **TUI (`App.tsx`, `factory.ts`, `onboarding.ts`, `SettingsPanel.tsx`, …)**:
  `MockProvider`, `SessionStore`, `builtinTools`, `loadMohConfig`,
  `writeMohConfig`, `upsertEndpoint`, `upsertMcpServer`, `declaredMcpServers`,
  `declaredUserMcpServers`, `defaultRegistry`, `resolveProvider`,
  `resolveProviderRef`, `minimalConnectionTest`, `BUILTIN_PROVIDER_TYPES`,
  `installFirstPartySkills`, `checkUpstreamUpdates`, `applyUpstreamUpdates`,
  `loadFirstPartyManifest`, `trackerTools`, `projectFrontier`,
  `resolveTrackerSync`, `McpRuntime`, `mcpServerEntrySchema`.
- **CLI (`run.ts`, `mcp.ts`, `permission-flags.ts`)**: `splitCommandSegments`.
- **@moh/extension package**: `diffSkillFiles`, plus the skill-upstream
  symbols already listed with TUI.
- **Types clients name**: `BuiltinProviderType`, `ConnectionTestResult`,
  `ConnectionTester`, `DeclaredMcpServer`, `EndpointProfile`, `McpServerEntry`,
  `MohConfig`, `TrackerBackend`, `TrackerIssue`, `UpstreamUpdate`.

Everything else — provider-error helpers, route/endpoint internals,
memory internals, skills discovery, subagent presets, session-store
internals, workflow/tracker plumbing — is internal.

## Consequences

- `index.ts` drops from 397 lines / ~90 re-exports to ~110 lines / ~55.
- Tests import from defining modules, so they now also exercise the real
  internal layout (closer to ADR-0003's collaborator structure).
- When the package is eventually published, the published surface is the
  reasoned list above; any addition is a deliberate contract decision.
- If an external consumer later needs an internal symbol, the path is:
  ADR (or ADR amendment) naming the door being re-opened, then the export.

## Amendment — 2026-09-04, #497 child-log tail seam

**Re-opened doors**: `tailChildLog`, `childTailLine`, `CHILD_TAIL_MAX_LINES`
and the `ChildTailLine`/`ChildActivity`/`ChildTailResult` types
(`core/src/child-tail.ts`), consumed by `@moh/tui` for the subagent chips +
live panel. The seam is pure data (an offset-based JSONL tail and a derived
activity snapshot) — no TUI concepts leak in; clients poll it on their own
cadence.

## Amendment — 2026-09-05, #499 usage quota seam

**Re-opened doors**: `getQuota`, `aggregateLocalUsage` and the
`QuotaReport`/`QuotaSource`/`QuotaWindow`/`QuotaOptions`/`QuotaFetch`/
`LocalUsageRow` types (`core/src/quota/`), consumed by `@moh/tui` (usage
quota modal on ctrl+q) and available to library embedders. The seam is
narrow and stable by construction: one probe function returning a typed
report or `null` on any failure, with all per-provider endpoint details
internal to `core/src/quota/*` — endpoint churn never surfaces. The local
aggregation helper is the always-available fallback over the event log.

## Amendment — 2026-09-05, #498 max-iterations config surface

**Re-opened doors**: `MAX_ITERATIONS_UNLIMITED`, `resolveMaxIterations`,
`DEFAULT_MAX_ITERATIONS` (`core/src/session/agent-loop.ts`), consumed by
`@moh/tui` (settings row) and `@moh/cli` (`moh run --max-iterations`).
The sentinel semantics (0 = unlimited, absent = 50) live in one core
resolver so the TUI cycle and the CLI strict parse project the same
contract instead of duplicating it; the loop guard itself stays internal.

## Amendment — 2026-09-10, #594 broad handoff discovery seam

**Re-opened doors**: `discoverGistHandoffs` and the `GistHandoffOffer`/`DiscoverGistHandoffsOptions` types (`core/src/handoff-gist.ts`), consumed by the TUI cold-start wizard and CLI. The seam deliberately returns only a compact, typed offer list and fail-silently returns `[]`; authenticated secret-gist enumeration, tag validation, candidate fetches, pagination, and `gh` details remain internal. This lets each client choose its own offer UI without duplicating remote discovery or exposing raw artifacts at the package boundary.

## Amendment — 2026-09-07, #551 live model-catalog seam

**Re-opened doors**: `fetchLiveCatalogs` and the `LiveModelListing` type
(`core/src/live-model-catalog.ts`), consumed by `@moh/tui` (background
model-list augmentation at startup and the `/model` picker's `r`
refresh). One orchestrator function taking endpoint descriptors and
returning per-endpoint live listings; the fetchers, the union parser,
the merge projection, the cache file and the `liveModels` config reader
stay internal to the defining module (core tests import it directly).
The seam is deliberately fail-silent and never mutates the auth store.

## Amendment — 2026-09-10, #575/#576/#577 session-tree identity and projection seams

**Re-opened doors**: `resolveEventRef`, `lineRef`, `parseLineRef`,
`resolveHead` (#575/#576) and `activePath` (#577)
(`core/src/session/event-log.ts`, re-exported via `core/src/session-store.ts`),
consumed by `@moh/tui` / `@moh/cli` (tree surfaces, divergence adoption,
`moh compact` readers) and available to library embedders. These are the
read-side complements of the `switchBranch` writer seam (#576): reference
resolution, branch-aware head resolution, and the active-path projection
that defines what the model context sees. The session-tree ADR is
ADR-0023; the specs (`docs/spec/session-tree-*.md`) remain the normative
semantics source. Future client-facing projections (`sessionTree`,
#580) build on `activePath` and will record their own doors.

## Amendment — 2026-09-10, #579 bookmark writer seam

**Re-opened door**: `bookmarkNode(file, to, name?)` (`core/src/session-store.ts`)
— the writer seam that appends the `tree_bookmarked { to, name? }` chrome
event (ADR-0023 §4, spec `session-tree-surfaces.md` §4): append-only,
last-wins per node, an explicitly empty name is the reset, `to` resolves
as ULID or `line:N` bridge (write-time validated, same discipline as
`switchBranch`). Chrome only: never provider context, never compaction
input; the event is itself a tree node counted for topology. The
live-writer twin is `session.bookmarkNode(to, name?)`; consumed by the
TUI `/tree` panel (#581) and `moh sessions bookmark` (#582).

## Amendment — 2026-09-10, #580 the client-facing tree projection

**Re-opened door**: `sessionTree(file)` plus the `TreeView`/`TreeNode`
types (`core/src/session-store.ts`) — the client-facing projection of a
session file (ADR-0023 §1, spec `session-tree-surfaces.md` §1): nodes in
file order with precomputed depth, active-path membership, kind
(turn/chrome), derived label and last bookmark state, plus the head id
(`line:N` for a purely legacy tail). Returns `{ error }` on an
unreadable/corrupt/empty log, never throws. This is the single seam both
the TUI `/tree` panel (#581) and the CLI renderer (`moh sessions tree`,
#582) consume — clients never re-walk the log themselves.

## Amendment — 2026-09-11, #614 MPM read-only status/query seam

**Re-opened door**: `MpmService` with `status` (`"ready" | "unavailable"`)
and `query(seedPath)` (`{ paths, provenance }`), plus the record/provenance
types (`core/src/mpm/`) — the single headless Moh Project Map service for
one project (spec #613). The storage layer (`MpmStore`, shard/journal
files) stays internal: clients read status and query results only, never
projection files. Needed by the TUI status row (#619), the CLI
diagnostics (#618), and future subagent orientation (#620); the surface
is read-only by construction — no client mutates the map through it.

## Amendment — 2026-09-12, #616 `MpmService.record(path)`

**Re-opened door**: one additional read-only accessor, `record(path)`
(the exact `MpmFileRecord` for a mapped path, or null), consumed today
by the core-internal `MpmOrientation` (#616) for hash-based freshness
checks on orientation-plan candidates. Same read-only-by-construction
guarantee as the #614 amendment; the storage layer stays internal. The
`mpm` prompt section and the orientation builder itself stay internal —
`SessionConfig.mpm` accepts an already-exported `MpmService`, so no
type in the config surface is new.

## Amendment — 2026-09-12, #618 MPM user controls and diagnostics

**Re-opened door**: the MPM config/diagnostics seam for clients and the
user config surface — `resolveMpmConfig`/`readMpmUserConfig` and their
types (`MpmUserConfig`, `MpmProjectConfig`, `MpmEffectiveConfig`, from
`core/src/mpm/config.ts`), `mpmDiagnostics` + its types (from
`core/src/mpm/diagnostics.ts`), and `projectMapDir` (the one path
constant the CLI needs to reach a project's projection). Needed by the
`moh mpm` CLI command (#618) and the TUI status/inspection row (#619).
The projection stays read-only metadata (status, counts, patterns,
budgets — never source content or prompt text); `MpmService` remains the
only writer. `projectMapDir` was already the core-internal constant used
by session assembly; exporting it keeps the path spelling in one place.

## Amendment — 2026-09-12, #620 MPM session continuity seams

**Re-opened door**: the handoff warm-up validation helpers
(`validatedWarmupPaths`, `requestWarmup`, `pathsFromTestCommands`,
`staysInsideRoot`, `HandoffWarmupHints`, from `core/src/mpm/handoff-warmup.ts`)
and the `SubagentOptions.mpm.snapshotFor` closure shape. Needed by
clients that wire handoff reception to a local non-blocking warm-up and
by the core's subagent host to hand children a bounded, read-only
orientation snapshot. The child seam carries only rendered plan text —
never the `MpmService`, the lifecycle, or any mutation surface; warm-up
paths are validated against the receiving checkout and drive only
targeted local refreshes. The projection remains read-only for every
consumer; `MpmService` stays the sole writer.

## Amendment — 2026-09-15, #714 multi-session telemetry seam

**Re-opened doors**: `aggregateTelemetry` and the `TelemetryReport`/
`TelemetryModelRow`/`TelemetryToolRow`/`TelemetryRouteHealth`/
`TelemetryFallbackRow`/`TelemetryRouteServingRow`/`TelemetrySessionRow`/
`TelemetrySubagentRow` types (`core/src/telemetry.ts`), the deep module
the `moh usage` CLI/TUI surfaces (#715–#718, in flight) project. One
read-only aggregator over the project's session files: per-model usage
(the `aggregateLocalUsage` math, not a fork), tool statistics, route
health, and per-session rollups — metadata only, all-local, corrupt
files skipped and counted. The `sessionsSkipped` counter covers both
corrupt/unreadable and empty session files.

## Amendment — 2026-09-16, #719 estimated pricing seam

**Re-opened doors**: `estimateModelCost`, `pricingForModel`,
`PRICING_SNAPSHOT`, and their `ModelCostEstimate`/`ModelPricing` types. The
CLI usage report and TUI quota modal need one shared, read-only interpretation
of the release-pinned catalog rates. The seam accepts only a recorded model id
and measured input/output tokens and returns no value when pricing is absent or
ambiguous; it never contacts a provider or modifies the append-only log.

## Amendment — 2026-09-16, #672 `lastAssistantText`

**Re-opened door**: `lastAssistantText(events)` (`core/src/session-store.ts`),
the read-only projection of the last completed assistant turn (cleared by
any later user message). Consumed by the TUI `/copy` command so the copy
source is exactly what the event log recorded — the core stays headless
and the clipboard transport stays client-side. No other store internals
leave the package.

## Amendment — 2026-09-18, #767 single-session analysis seam

**Re-opened doors**: `analyzeSession(file)` and its `SessionAnalysisReport`
plus row/stats types (`core/src/session-analyze.ts`). The CLI
`moh sessions analyze` report and the TUI `/session` modal need one shared,
read-only metadata projection over a single session event log — the
per-session sibling of the #714 cross-session aggregator — instead of each
client forking the aggregation math. The seam opens the log through the
shared store reader (disposed immediately; the open registry never records
a view), projects the active branch via `activePath`, reuses the #499/#719
usage and pricing conventions, and returns an explicit `{ error }` on an
unreadable or empty log. Metadata only: never message content, tool
outputs, or reasoning; never a write to the log.

## Amendment — 2026-09-23, #935 browser toolchain seam

**Re-opened doors** (`core/src/browser-toolchain.ts`): `browserToolchainRoot`,
`probeBrowserToolchain`, `installBrowserToolchain`, and the types they
name — `BrowserToolchainStatus`, `BrowserBuildStatus`,
`BrowserToolchainOptions`, `BrowserToolchainInstallOptions`,
`BrowserToolchainInstallResult`, `BrowserToolchainProgress` — plus the
copy constants every surface must share (`BROWSER_SETUP_HINT`,
`BROWSER_WITH_DEPS_NOTE`, `HEADLESS_SHELL_DOWNLOAD_SIZE`,
`FULL_CHROMIUM_DOWNLOAD_SIZE`).

Consumed by the TUI (the Browser setup flow of #934 and the
`browser_unavailable` warning action of #936) and by the CLI (the headless
setup/diagnostic line). Both clients must show the same toolchain truth and
offer the same setup: probing, the package-resolution order, the download
sizes and the installer are exactly the logic that would otherwise be
forked per surface — the duplication this ADR exists to prevent. The seam
is deliberately narrow: probing returns a status with actionable reasons
(never throws, never a session failure), installation returns an explicit
`{ ok: false, kind }` instead of throwing. Everything else —
`resolvePlaywright` and the resolution order, the lock protocol, the
staging/symlink swap, the Playwright registry access, the embedded-Bun
invocation — stays internal to the defining module (tests import it
directly, per this ADR).
