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
