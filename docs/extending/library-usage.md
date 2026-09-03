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
to resume or `fork()` to branch later.

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
surfaces one warning. A client may also attach its best-effort publish
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

## What's intentionally not here

`@moh/core` exports a curated surface (ADR-0004): the session entrance,
`sessionFromConfig` and its types, the permission-rule codec, and what
the shipped clients need. Provider registry plumbing, memory internals,
subagent presets, and skills discovery are internal — if you need one of
those doors opened, that's an issue + ADR, not an import path.
