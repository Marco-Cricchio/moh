# Embedding moh as a library

**Who this is for:** you are embedding `@moh/core` in your own program —
a bot, a pipeline, an evaluation harness, your own client. If you instead
want to observe/restrict a running moh session from inside it, read
[extensions.md](extensions.md).

Everything you need is the ADR-0004 keep-list exported from
`@moh/core`. The three pieces that matter:

1. **`sessionFromConfig`** — the single assembly path (ADR-0005).
2. **The event log** — `session.events`, an async iterable that *is* the
   session: streaming, persistence, resume are all projections of it.
3. **Headless permission seams** — permission rules as strings, one
   grammar everywhere (ADR-0007), plus optional consent callbacks.

## A working walkthrough

The full runnable script lives at
[examples/library-walkthrough.ts](examples/library-walkthrough.ts) (`bun
docs/extending/examples/library-walkthrough.ts` from the repo root).

### 1. Assemble a session

```ts
import { sessionFromConfig } from "@moh/core";

const assembled = sessionFromConfig({ cwd, home, provider });
if ("error" in assembled) throw new Error(assembled.error.message);
const { session, store } = assembled;
```

`sessionFromConfig` owns the whole choreography: moh.json read, user-level
provider layering (the `provider`/`endpoints` sections of `~/.moh/config`
merge under the project ones — endpoints by `name`, per-field, project
winning; keys and the default reference resolve env var > project > user,
see `loadMergedConfig`), project + user MCP server merge, provider
resolution, subagent/memory wiring, store creation, session creation. It
returns an explicit `{ session, store } | { error }` — **no silent
fallbacks**. Provider resolution is one path: a pre-built `provider`
instance (used here, e.g. a `MockProvider.cassette` for evals) > an
explicit `providerRef` (like the CLI's `--provider`) > the merged config's
`provider` (project moh.json > user config) > the zero-config `"mock"`
default. An invalid user `provider`/`endpoints` section fails loudly as a
`config` error, like a broken moh.json.

moh.json's `maxIterations` (#190) configures the per-turn tool-call cap
(default 50). Reaching the cap no longer kills the turn: the core makes
one final **no-tools wrap-up call** — the model must reply with what it
completed, what remains, and the next step — and the turn ends `done`
instead of `error` (subagent children inherit the same behavior; a
failing wrap-up call degrades to the historical `max_iterations` error).
`maxIterations: 0` is the unlimited sentinel (#498): the guard never
fires; resolve it with the exported `resolveMaxIterations` (absent → 50,
`0` → `Infinity`, finite → itself).

`AssemblyError.kind` tells you what to do: `config` / `provider` are
user-fixable (surface the `message`); `session` is a startup validation
error (e.g. a corrupt resumed log). The store is only created after
validation, so a broken config leaves no orphan session file.

**Subscription (OAuth) endpoints.** An endpoint profile may carry
`auth: { kind: "subscription" }` (absent = api-key, the backward-compatible
default). Subscription endpoints resolve their credential automatically at
stream time: the access token is read from the `auth` section of
`~/.moh/config` (ADR-0009 — never moh.json), refreshed proactively before
the single stream call when near expiry, and a failure surfaces as a
`ProviderError` of kind `auth` pointing at `moh provider login <name>`. As
an embedder you do nothing: no token plumbing, no refresh handling — the
login flow itself is a CLI concern (`moh provider add` / `login`), driven
through the `OnboardingIo` seam (which grew a best-effort `openUrl` for
headless-safe OAuth). After a successful login the wizard offers the
provider's model list from the vendored catalogs
(`subscriptionModelCatalog` in `@moh/core` — verbatim pi-ai data, see
`src/model-catalogs/README.md` for attribution and regeneration); free-text
entry stays as the advanced fallback. Most openai-compat endpoints have no
vendored catalog: `listOpenAiCompatModels(baseUrl, apiKey?)` fetches
`GET <baseUrl>/models` live (used by the model pickers; a failure falls
back to free-text entry). The recognized `api.z.ai` host is an exception:
moh ships pi-ai's Z.ai GLM catalog, so its picker and context bar use the
published model metadata (including context windows) without a live fetch.
Onboarding a Z.ai URL automatically records the corresponding explicit
thinking capability declaration.

**Live catalog augmentation (#551).** Catalog-backed endpoints get
their picker lists augmented with the provider's own live model list —
one **verified contract per provider**, never a generic guess:
`openai` rides the ChatGPT/Codex backend (`/models?client_version=…`,
`originator` header, `models[].slug`, only `visibility: "list"` +
`supported_in_api` rows); `anthropic` and `google` paginate
(`has_more`/`after_id`, `nextPageToken`); `openrouter`, `xai` and
`github-copilot` speak the OpenAI-like `data[].id` shape (copilot with
its full editor-header client profile). `kimi-coding` and the Z.ai
Coding Plan have **no verified listing contract and are deliberately
static** — the regen-from-pi-ai path remains their update story.
`fetchLiveCatalogs(endpoints, opts)` in `@moh/core` is the single
orchestrator (startup and picker open), caching results in
`~/.moh/live-models.json` (TTL from the `liveModels` user-config
section, default 24h; `enabled: false` restores the fully static
catalog) and merging additively — the vendored catalog always wins on
id collision, and fetched-only models carry conservative metadata (moh
never invents capabilities). Any failure degrades silently to the
static list. Both the `/model` modal and the Settings panel's model
picker consume the same live projection. This is a picker/cache seam
only: routing, `catalogEntryFor` and thinking resolution keep reading
the vendored data.

**Thinking capability declarations (#256).** An endpoint profile may
declare a thinking capability in `capabilities`: `thinking` (endpoint-
level: `{ format, levels }`) and `thinkingModels` (per-model overrides,
`{ levels }` with an optional `format` inheriting the endpoint-level one).
`format` is one of `openai-effort`, `openrouter-effort`,
`anthropic-effort`, `google-thinking-level`; `levels` lists canonical
thinking levels (`off`…`max`) the backend accepts. This is the capability
source for ordinary `openai-compat` models (which carry no catalog metadata)
and an explicit per-model override on catalog-backed endpoints. The Z.ai URL
recognized by onboarding receives `{ format: "openai-effort", levels:
["off", "low", "high", "max"] }` automatically; custom compat hosts stay
conservative unless the user adds their own declaration. Absent
declaration, behavior is conservative: no level selection, no invented
request fields. Declared levels are intersected with what the format's
wire can express (e.g. `google-thinking-level` has no `xhigh`/`max`).

**Catalog gaps and the declaration as escape hatch (#338).** Some
catalog-backed models are flagged `reasoning` upstream without a thinking
level map, so `/thinking` and Ctrl+Y offer no level control for them. The
regeneration script (`packages/core/scripts/regen-model-catalogs.ts`)
fills what it can by exact model-id match across pi-ai's catalogs; the
residual is genuinely unlabelled upstream. For those models, an explicit
`capabilities.thinkingModels` declaration on the endpoint profile (same
mechanism as above) enables level control without waiting for upstream
data.

### 2. Consume the session through `events`

The event log is the session: an append-only sequence of `AgentEvent`s
(`session_start`, `user_message`, `assistant_delta`, `tool_call`,
`tool_result`, `model_call`, `done`, `error`, `cancelled`, …). Consume it
as an async iterable while turns run. A `tool_call` may carry the call's
effective `timeoutMs` (resolved by the tool, defaults included) — clients
can render a live limit from it without duplicating per-tool defaults.

```ts
async function watch() {
  for await (const event of session.events) {
    console.log(JSON.stringify(event));
    if (event.type === "done") break;
  }
}
const [turn] = await Promise.all([session.send("check the repo"), watch()]);
await session.dispose();
```

Every event is also persisted (the `sink` you can add via
`overrides.sink` fans out on top of the store append) to
`store.file` — one append-only JSONL per session, which you can `load()`
to resume or `fork()` to branch later. Since the session tree (#577), a
file may hold abandoned branches: `sessionFromConfig` and every core
consumer replay the **active path only** (the `activePath(events)`
projection exported from `@moh/core`) — switching branches is how the
model sees a different past. To render the file's shape instead of
replaying it, `sessionTree(file)` gives you the client-facing view in
one call: nodes in file order with `depth`, `onActivePath`, `kind`,
derived `label`, `bookmark` state, and the `headId` (`TreeView`,
exported from `@moh/core`; `{ error }` on an unreadable log).

Session files are **single-writer** (#400): an open session probes its
file's size at every append boundary, and growth from elsewhere (another
machine over a sync channel, a second process) is appended as a
`session_file_growth` chrome event — a warning you should surface, never
provider context. The local writer's appends are not blocked: they
continue on the tail, intact. Concurrent use of the same session file on
two machines is unsupported — use a session serially (close on one
machine, then resume on the other), and fork the session when a growth
warning fires.

`send` accepts options (ADR-0011): `session.send(text, { prompt: { name,
text } })` attaches a turn-scoped skill prompt that rides the system
prompt for exactly one turn — the user message (and its persisted event)
stays the clean text, and a `skill_invoked` chrome event records the
invocation. See `docs/extending/skills.md`.

### File mentions (#488)

Any sent text — TUI or headless — goes through mention expansion: a
user-typed `@path` token stays in the message text while the core
attaches a structured snapshot on the `user_message` event (file
content capped at ~200KB with a truncation marker, binaries base64
with a detected mime, directories a recursive path listing). `read:`
permission rules gate every snapshot — a denied or missing path appends
a `mention_warnings` chrome event instead of an attachment, never a
turn error. The helpers are exported: `expandMentions(text, cwd)`
parses and resolves tokens; `assembleMentions` builds the attachments
with a custom `canRead` gate; `renderMentionAttachment` renders one
attachment as a provider-facing text block (what replay rebuilds).

### 3. Permissions, headless

Permission rules have one string grammar (ADR-0007), the same one the
TUI renders and the CLI's `--allow`/`--deny` flags parse:

```
rule      := tool | tool ":" argspec
argspec   := command-prefix (bash) | path-glob (any path-arg tool)
```

Examples: `bash` (bare tool), `bash:git status` (shell-word token
prefix), `write:src/**`, `edit:docs/*.md` (root-anchored path globs). The
effect ("allow"/"deny") is not part of the string; the caller supplies it.
The core owns the codec:

```ts
import { formatRule, parseRule, overridesFromFlags, RuleError } from "@moh/core";

const rule = parseRule("bash:git status", "allow"); // throws RuleError on bad input
formatRule(rule); // -> "bash:git status" — every formatted rule reparses
```

`parseRule` rejects empty rules, compound bash commands (one flag per
segment) and `tool:` with no matcher. Tokens mixing `"` with whitespace
cannot round-trip (documented limit — the grammar has no escape
sequence). For the CLI-shaped case there is one seam:

```ts
overrides: { permissionFlags: overridesFromFlags(["bash:git status"], ["write:secrets/**"]) }
```

Flags merge on top of moh.json permission overrides — caller wins. If you
want the structured form instead, pass `overrides.permissions.overrides`
directly (`tools`/`bashAllow`/`pathAllow`/… lists).

**Yolo sessions (#377).** `PermissionsConfig.unrestrictedTools: true`
(launch-only, never settable from moh.json, Settings, or in-session)
selects the `yolo` session mode: built-in tools run with no permission
prompts **and** no filesystem containment to the project root —
`read`/`glob`/`grep`/`write`/`edit` may target any path, still resolved
canonically (realpath, symlink-aware; only the containment check lifts).
Recorded as a `session_mode` event with `mode: "yolo"` and grants carry
`reason: "yolo"`. Two things always survive: extension vetoes (principle
4 — extensions restrict, never grant) and MCP tools' ask flow, including
server first-use consent. Normal mode is unchanged.

### 4. Consent seams (or none)

Without consent callbacks, the session is **headless fail-fast**: a tool
that isn't permitted by the rules becomes a structured denial the model
sees (never a prompt), and project MCP servers that need trust are not
started. To make it interactive instead, inject the seams — this is the
same interface the TUI uses:

```ts
const assembled = sessionFromConfig({
  cwd, home, provider,
  consent: {
    onPermissionRequest: async (tool, args) => /* "yes" | "always" | "no" */ "no",
    onAskUser: async (set) => /* an AskUserSetResult */ { answers: [{ labels: ["1"] }] },
    onMcpTrust: async (server) => /* "yes" | "always" | "no" */ "no",
  },
});
```

`"always"` answers become runtime rules (tier 3 — they only narrow, never
widen built-in defaults) and are recorded as `permission_rule_added`
events, so they persist across resume of the same log. When a resume restores
one or more rules, the session appends one `permission_rules_restored` chrome
event containing their canonical rule strings; clients should surface it to
make inherited grants visible.

### MCP stdio environment

For privacy, stdio MCP servers do **not** inherit the launching process
environment. Their base environment contains only `PATH`, `HOME`, `TMPDIR`,
`LANG`, and `TERM` when present; the server declaration's `env` entries are
then applied and override those values. Declare every variable required by a
server explicitly in its `env` block, including variables that it previously
inherited (such as provider credentials).

## Provider reasoning and thinking levels (#240)

Reasoning-capable providers may emit neutral reasoning stream events
(`reasoning_start` / `reasoning_delta` / `reasoning_end`). Completed
reasoning is persisted as a `reasoning` `AgentEvent` (with the provider's
opaque continuation artifacts, e.g. signatures) and is replayed into the
provider context on resume and fork — no SDK type ever crosses the core
boundary. A call interrupted before its provider message is finalized is
not checkpointed, even if its reasoning block ended first. Compaction
replaces the pointed-to old prefix with its summary in provider context but
keeps recent reasoning in the tail; the integral JSONL remains unchanged.
Session exports and backups therefore contain retained reasoning and opaque
metadata. See [Provider reasoning and thinking controls](../provider-reasoning.md)
for the user-visible privacy and display behavior.

A custom provider can emit these events without importing anything from
the AI SDK; providers that don't are untouched.

### Live reasoning (#253)

Reasoning deltas are delivered live, for every catalog provider that
streams reasoning: the session exposes `onLiveEvent(listener)` (returns an
unsubscribe function), which receives the neutral reasoning lifecycle
(`ReasoningStreamEvent`) while the model thinks. The channel is ephemeral
— nothing it carries is stored, sunk, or dispatched to extensions — and
the completed block still lands in the append-only log as the `reasoning`
AgentEvent at call settlement, so resume/fork/export semantics are
unchanged. A TUI renders the live stream in a display-gated block and
clears it when the settled block arrives.

A session configured with `thinking: { level }` (canonical levels `off`,
`low`, `medium`, `high`, `xhigh`, `max`) passes a neutral
`StreamOptions.thinking` request to every provider call; a per-call getter
(`thinking: () => ({ level })`) may be used when an embedding client owns a
dynamic override. Each `model_call` event audits the effective level actually
sent. Levels a wire cannot express are not sent and not remapped.

When `thinking` is absent, a configured `endpoint/model-id` session resolves
the endpoint preference in `~/.moh/config` against that model's catalog map
before every call; a newly persisted change therefore applies to the next
call, including after a model switch. Embedding clients that need the same
projection can call `resolveEndpointThinking(ref, endpoints, userConfigFile)`.
It returns `{ level }` only for an offered canonical level; `undefined` means
provider default/no explicit request, never a fallback mapping. For status
display, `endpointThinkingStatus(ref, endpoints, userConfigFile)` adds the
`unsupported` marker — an intact stored preference the active model does not
offer ("provider default (preference X unsupported)"). The capability
calculation itself is `thinkingStatesForRef(ref, endpoints)`: per-model
config declaration > endpoint-level declaration > normalized catalog map.
Catalog `minimal` keys normalize into the canonical scale there (#256).

## Session handoff transport (#433)

The exit-time publish seam: a `HandoffTransport` (publish/fetch with
typed errors) injected by the client, never known to the agent loop.
The core ships one implementation — `createGistHandoffTransport`, a
secret gist via `gh` (deterministic tag `moh:handoff:<slug>:<gh-user>`,
tagged-gist replace on republish). `publishHandoffAtExit` reads the
raw artifact (#434) and publishes it bounded by a timeout budget — it
never rejects; on failure the artifact stays local and the caller
surfaces one warning. At publish the payload is stamped with the
publishing gh user (`author`, #451) and the canonical public https
clone URL of origin (`repoUrl`, #593 — absent when the project has no
git origin; receivers tolerate its absence). The publish guard (#593):
before replacing the tagged gist, a strictly newer remote `updatedAt`
requires the client's explicit consent through the injectable
`confirmOverwrite` seam — declining (or no seam wired, the exit paths'
default) publishes nothing and returns a typed `newer-remote` error;
local artifacts are never touched. A client may also attach its
best-effort publish
callback to a successful `bash` `git push`; it does not delay or alter
the tool result, and the core still knows neither the transport nor
`gh`. Active only when moh.json sets
`handoff.transport: "gist"`; everything else (absent, `"none"`) is
byte-for-byte today's behavior.

The receiving side (T3, #436) lives behind the same seam:
`discoverHandoff` fetches the newest published handoff (bounded, never
throwing) and compares it with the newest local session — a handoff
matching the local session id is `own-session`, one not newer than the
local file is `local-current`, any failure is a silent `none`. A
genuinely newer handoff comes back as an `offer` with a `stale` flag
(anchor SHA ≠ HEAD). Seeding is never a replayed event log: the client
opens a **new** session whose first turn carries the handoff rendered
by `handoffSeedPrompt` as a turn-scoped skill prompt (ADR-0011
pattern) plus the one-line `handoffSeedMessage` — stale offers include
an explicit reconcile-via-git instruction. The new session carries the
accepted payload's `{ sessionId, updatedAt }` as `supersedes` in every
subsequent raw artifact, making the logical A→B→A chain explicit even
though the gist stores only its newest tip. Ordering is the payload's
`updatedAt` (the origin machine's clock) against the local session
file's mtime; a tie or an older stamp is `local-current`, so clock
skew on the origin side can only ever make a handoff win by being
strictly newer — bounded in practice by the stale anchor check.

The manual file fallback (T7, #440) bypasses the transport entirely:
`moh handoff export <file>` writes the raw artifact (with the same
best-effort Wayfinder enrichment as a publish) to any carrier file,
and `moh handoff import <file>` validates a received export and parks
it under `~/.moh/projects/<slug>/imported-handoff.json`. Discovery
merges the parked import newest-of-both with the fetched gist — it is
offered only when no gist handoff won and it is genuinely newer than
local work — so a gh-less machine receives handoffs over removable
media while the newest-wins chain semantics stay identical. When the
deterministic-tag discovery misses but you have a direct gist URL,
`moh handoff pull <url>` fetches that specific gist through the
transport's `fetchByUrl` and runs the same reception pipeline.

Payload identity and safety (#451): the payload schema is version 2
and carries `author` (the publishing gh user, stamped at publish);
readers still accept v1 payloads — gist-sourced ones were per-author
by construction via the deterministic tag. File imports (`import`,
`pull`) of a payload authored by a different gh user are declined:
handoffs are per-persona (#433 Q6). Republishing is non-destructive:
the new gist is created before the old one is deleted, so a failed
create never destroys the remote copy.

## Session notes path (#467)

The core owns the canonical project directory: `projectSlug(cwd, home)`
resolves the slug — from the canonical `host/owner/repo` form of the git
`origin` remote when one exists (#591), otherwise from the
`.moh/project.json` identity — and `projectSessionsDir(cwd, home)`
appends it under `<home>/.moh/projects/`.
Both are exported from `@moh/core` (an explicit, minimal ADR-0004
reopening, decided in #467). The assembled prompt's environment section
already renders the session-notes path (`~/.moh/projects/<slug>/session.md`);
embedders who need the same directory should call these helpers rather
than recomputing the slug from the working directory. The core guarantees
the path only — session-notes content stays entirely with the
`session-memory` skill and is never read, written, or remembered by the
core (no double store with Memory).

## Usage quota probe (#499)

`getQuota(endpoint)` probes one endpoint's usage quota and returns
`{ source: "official" | "undocumented"; windows: [{ label, percent? | used/limit, resetAt? }] }`
or `null` on any failure — no credentials, unsupported kind, HTTP error,
or drifted schema. Credentials are reused from the endpoint profile and
the auth stores; the probe is best-effort with a short timeout and never
throws. Per-provider endpoint details stay internal: one module per
provider under `core/src/quota/`, so schema churn is a local fix that
never surfaces through the seam. `aggregateLocalUsage(events)` is the
always-available fallback: per-model token totals summed from a session's
`model_call` events. Both are exported from `@moh/core` (ADR-0004).

## Moh Project Map — read-only status and query (#614)

`MpmService` is the single headless MPM service for one project: it loads
(or fails safe and rebuilds) a disposable structural projection stored
under `~/.moh/projects/<slug>/project-map/` — sharded JSON with an
atomically-flipped manifest and a small append-only crash journal. It
answers small read-only structural queries: `query(seedPath)` returns
`{ paths, provenance }` where each provenance entry cites the source
path, line, and extractor that proved the relation. `status` is
`"ready" | "unavailable"`. The projection stores metadata only — paths,
hashes, symbols, relations — never source-file content, and is never
mixed into MemoryStore, the session event log, or handoff: corrupt or
incompatible data is discarded and rebuilt, never recovered from.
Exported from `@moh/core` (ADR-0004).

## Moh Project Map — orientation plans (#616)

For relevant codebase tasks the core injects a small, advisory
orientation plan into the prompt's `mpm` section (between `session_state`
and the trailing `extension_notes`). `MpmOrientation.planFor(text)` is conservative and
purely local: the task text must name a mapped path; every ranked entry
is extracted and fresh (the file's current hash still matches the
mapped one), cited with path, coordinate, relation, and a concise
reason. Ineligible or uncertain tasks — stale projections included —
receive no plan at all. Plans are advisory: they never restrict tools,
and never contain copied source excerpts. `SessionConfig.mpm` opts in
with an explicit `service`/`root`; `sessionFromConfig` activates
automatically when the project's projection exists. The plan is
turn-scoped: computed per send, cleared when the turn settles.

## What's intentionally not here

`@moh/core` exports a curated surface (ADR-0004): the session entrance,
`sessionFromConfig` and its types, the permission-rule codec, and what
the shipped clients need. Provider registry plumbing, memory internals,
subagent presets, and skills discovery are internal — if you need one of
those doors opened, that's an issue + ADR, not an import path.
