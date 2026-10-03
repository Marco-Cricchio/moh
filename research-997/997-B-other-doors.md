# #997-B — Every door that customises moh today, other than the `@moh/extension` hook runtime

Map: #996. Tree: `ff4a5ebd`. Scope: *inventory* of the non-extension customisation surfaces,
what each can do, its trust model, and how it overlaps with / competes with / silently defeats
the extension platform (ADR-0031/0032/0033/0034/0036/0039, `packages/extension/src/index.ts`).

The extension platform's own powers, for reference (what the doors below are compared against):
phase hooks with restrict-only `veto`/`ask` (`extensions.ts:1445-1485`), `appendToPrompt`
durable notes + `setPromptNote` per-turn notes (`prompt-composer.ts:159-166`, section order
`SECTION_ORDER` includes `extension_notes`, `turn_notes`), `appendEvent` chrome
(`extension_event`, runtime-stamped) and `setStatus` footer status
(`packages/extension/src/index.ts:397-431`), `beforeTurn` model switch + confirm
(ADR-0033), `onToolResult` withholding (ADR-0034), `onCompaction` section filter (ADR-0035),
client→extension control channel `setExtensionState` (`session/session.ts:1212-1217`), and a
consent gate tied to resolved path + SHA-256 of the file's bytes (`extension-source.ts:1-20`),
with headless fail-closed (`extension_failed { reason: "consent" }`).

---

## 1. MCP servers — `packages/core/src/mcp/**`

**Power.** A `moh.json` `mcpServers` entry (or a `~/.moh/config` one) starts a child process
or HTTP session and injects its tools into the session tool registry as `mcp__<server>__<tool>`
(`mcp/runtime.ts:213-250`, `config.ts:246-249`), merged into the live tool map at
`session/session.ts:1248` (`#allTools()`). Tools carry a description and no input schema (the
server validates its own arguments, `runtime.ts:220-222`); calls get a fixed 60 s timeout
(`runtime.ts:233-238`). Crash handling is explicit: no auto-restart, the wrapper stays
registered and returns an "unavailable, manual restart" error (`runtime.ts:150-165`).

**Deliberately absent.** Sampling, roots and elicitation are answered `-32601` and recorded as
`mcp_refused` (`runtime.ts:28-32`, `:138-141`). Only `tools/list` is called
(`runtime.ts:177`); server-initiated notifications are dropped and resources/prompts are never
consumed (`json-rpc.ts:87`). So an MCP server is a *tool source only* — no resources, no
prompts, no subscriptions, no server→client capability.

**Trust model.** Two scopes (`mcp/types.ts:33-47`): `project` (declared in `moh.json`) asks
consent once before first start; `user` (`~/.moh/config`) is trusted and never asks
(`runtime.ts:200`). "Always" persists to the **user** config's `mcpTrust` section keyed by
project slug (`mcp/types.ts:80-105`, written through `session/session.ts:562`); the repo's own
`trusted: true` in `moh.json` parses but is never read (SEC-01, `from-config.ts:328-333`).
Trusted servers' tools are auto-allowed by an in-session runtime rule
(`session/session.ts:565-568`). Headless with no consent seam = project servers denied and
skipped (`runtime.ts:120-124`). stdio servers do **not** inherit the process environment —
only `PATH`/`HOME`/`TMPDIR`/`LANG`/`TERM` plus the declaration's `env`
(`docs/extending/library-usage.md`, "MCP stdio environment").

**Overlap with the extension platform.**
- *It is the same power, already shipping.* "Add a capability to moh without touching core" is
  today spelled "write an MCP server in any language". MCP is a **process-boundary extension
  platform**; the `@moh/extension` runtime is an in-process one. Anything a ticket asks for as
  "extensions should be able to add tools" already exists for anyone willing to speak JSON-RPC.
- *Tools arrive in the same registry as built-ins* (`#allTools()`), so extension hooks **do**
  see them: `PermissionGate.check` runs `checkToolHooks` before rule resolution for every tool
  (`session/permission-gate.ts:70`). An MCP tool is therefore vetoable/askable — no bypass.
- *They partially defeat the platform's teeth in yolo.* `yolo` lifts prompts for built-in tools
  but explicitly **not** for `mcp__*` (`permission-gate.ts:97-104`), i.e. MCP keeps an ask flow
  the extension veto cannot grant back. Conversely, extension `ask` packets are *ignored* in
  yolo (`permission-gate.ts:88-89`) while an MCP ask survives: the two "ask" sources have
  different survival rules.
- *Trust model competes with the extension consent model.* MCP grants a *server* durable trust
  by project slug (`mcpTrust`) plus a per-tool `allow` rule written into `moh.json`
  (`permission-gate.ts:157-165`, `config.ts:264-271`); the extension platform grants durable
  enablement per *file content hash*. A repo can ship an MCP server and — after one "always" —
  the same repo's tool allow-rule persists into the repo-controlled file; the extension platform
  never lets a project self-activate.
- *Subagents never inherit MCP* (`subagents.ts:237`: names starting `mcp__` are always dropped).
  No analogue exists in the extension contract.

---

## 2. Skills — `skills.ts`, `skill-args.ts`, `skill-routing.ts`, `workflow.ts`

**Power.** `~/.moh/skills/<name>/SKILL.md` and `<project>/.moh/skills/<name>/SKILL.md` are
discovered by directory scan; project wins on name clash (`skills.ts:82-103`). Frontmatter
(`name`, `description`) feeds a **name—description index** in the prompt
(`prompt-composer.ts:250-260`); the body is pulled on demand through the `read` tool, and a
turn-scoped invocation goes through `send(text, { prompt })` → `skill_invoked` chrome
(`session/session.ts:253-262`, `docs/extending/library-usage.md`). `skill-args.ts` substitutes
`$1`/`${key}` placeholders (TUI slash aliases, `tui/src/commands.ts:756-790`). `skillRouting`
maps tracker labels → slash commands, overridable/disable-able per label from `moh.json`
(`skill-routing.ts:46-71`, `config.ts:107-113`).

**Trust model.** *No trust model at all.* No consent, no signature, no ownership check: a
cloned repo that contains `.moh/skills/<x>/SKILL.md` has its skill indexed in the prompt and
available to `read` immediately. The only ownership concept is the first-party manifest
`.moh-first-party.json` (`skills.ts:46-57`), which is used to *exclude* moh-owned skills in
non-workflow mode — not to gate foreign ones. `workflow.ts` adds an opt-out upstream fetch of
first-party skills with a `minMohVersion` gate and a content-hash check before overwriting an
unmodified local copy (`workflow.ts:1-30`).

**Overlap with the extension platform.**
- Skills are the **prompt-level** door: they change what the model is told, which is what
  `appendToPrompt`/`setPromptNote` also do — but skills are unbounded in size,
  multi-turn-persistent by model choice, and need no runtime. The extension `turn_notes` section
  is deliberately truncated and one-line-per-extension (`prompt-composer.ts:161-166`); the
  prompt-file door (§9) is unbounded. So when a ticket says "extensions should influence the
  prompt", note that two doors already do, with incompatible budgets.
- The **first-party manifest** is extension-platform-adjacent bookkeeping (moh-owned assets,
  hash-checked upgrades) implemented *outside* the extension runtime; it is a precedent for the
  "bundled but user-copied" posture that ADR-0039 later generalised.

---

## 3. Providers — `provider-registry.ts`, `provider-profiles.ts`, `provider-config.ts`, `model-catalog*.ts`

**Power, three distinct doors.**
1. **Config-only providers**: `openai-compat` + `endpoints[]` in `moh.json`
   (`config.ts:56-87`) covers any OpenAI-compatible base URL with no code — baseUrl required
   (`provider-registry.ts:131-133`). Eight-plus first-party profiles are closed unions
   (`provider-profiles.ts:17-34`).
2. **Programmatic**: `registerProvider(id, factory)` on a mutable `ProviderRegistry`;
   a session freezes the registry at creation, so later registrations never affect running
   sessions (`provider-registry.ts:2-6`, `:56-90`). Exported as `defaultRegistry` and the
   `ProviderRegistry` type from `@moh/core` (`index.ts:115`, `:817`, `:896`). A factory returns
   a single-shot `Provider` (`types.ts:198-211`).
3. **Credentials/merge**: user `~/.moh/config` `provider`/`endpoints` merge under the project's
   per-field, with an explicit name-collision refusal because credentials resolve by name
   (`provider-config.ts:95-125`); keys resolve env > project > user.

**Trust model.** `moh.json` may declare endpoints and inline keys (with a mode warning and
forced 0600 on write, `config.ts:206-232`), but `auth` (subscription tokens) lives only in the
user config (ADR-0009) and a project `typesafe` block is meaningless (user-config-only by
ADR-0039 §, `docs/manual/config-reference.md:184-192`). Custom (factory) ids cannot be fallback
stops (`provider-registry.ts:215,278`) — a registered provider is a *leaf*, not a peer.

**Overlap / conflict.**
- `registerProvider` is **the door an extension platform would want and cannot use**: it is a
  synchronous registry mutation available to an embedding program before
  `sessionFromConfig`, not a hook an extension can call at load time (the registry is frozen
  into the session at creation). An extension that wants to add a provider has no seam; a
  library user has one but only at assembly. This is the clearest **missing** power on the
  extension side that an unrelated door already grants.
- The `openai-compat` profile is the *declarative long tail*: it grants "talk to any
  OpenAI-shaped backend" with no code and a project-visible config, at the cost of being
  wire-locked (`openai-chat`). The extension platform has no equivalent declarative escape
  hatch; `capabilities.thinking` (`config.ts:33-55`) similarly grants capability metadata that
  no extension hook can supply.
- Provider resolution is one path with **no extension-visible phase**: `beforeModelCall` can
  observe/influence a call (`extensions.ts:162` area) but cannot substitute the Provider
  instance; there is no `resolveProvider` hook.

---

## 4. moh.json — the project config surface — `config.ts`

**Power.** One non-strict zod object owns everything: `provider`, `endpoints`, `permissions`,
`extensions`, `mcpServers`, `agents` (subagent presets overriding built-ins), `memory`,
`compaction`, `handoff`, `skillRouting`, `routingPool`, `maxIterations`, `mpm`, `browser`
(`config.ts:103-177`). Unknown keys are stripped; invalid values are a hard error
(`config.ts:185-204`).

**Trust model.** Weak by construction and *deliberately asymmetric*: the file lives in the repo
and is read at session assembly, but the keys that could grant standing authority are refused
there — `mcpTrust` (only `~/.moh/config`, `mcp/types.ts:80-105`), `typesafe` (only user config,
ADR-0039), `auth` (only user config, ADR-0009). What a project *can* still do: declare MCP
servers (consent-gated), declare `extensions` paths (proposal only, consent-gated), change
provider/endpoint defaults, add permission rules, turn on the browser tool, enable MPM.

**Overlap.** `moh.json` is the **precedent and the counter-model** for extension activation: a
project file may *propose*, the user *disposes* (`extension-source.ts:10-16`). Any new
extension-platform power expressed as a `moh.json` key inherits this asymmetry and must decide
which side of it the key sits on.

---

## 5. Drop-in assets: themes and icons

**Themes.** `~/.moh/themes/<id>.json` — declarative JSON only: `version: 1`, slug id, display
name, `extends` (a *built-in* preset only), partial `colors` map over real semantic tokens
(`tui/src/user-themes.ts:1-27`). Explicitly "no executable code, no user-theme inheritance, no
`$schema`". Listed as `[u]` in the picker (`:33-45`). **Trust model: none needed** — the door
is closed to code by format.

**Icons.** A boolean-ish global toggle rendered through `glyph()`
(`tui/src/icons.ts:10-22`); **not** a drop-in asset, only on/off.

**No user keybindings exist.** There is no keymap file, no `keybindings` config key; the
keymap is compiled into the TUI (`docs/manual/commands-and-keys.md` is the only surface).

**Overlap.** Themes are the **counter-example to cite**: moh already has a third-party drop-in
directory whose safety argument is *"the format cannot express behaviour"*, and whose
inheritance is deliberately one level deep. It is the precedent for a non-code extension door
and the argument against widening it (`docs/extending/`).

---

## 6. Workflow mode — `workflow.ts`, Frontier panel, `handoff*.ts`

**Power.** `/workflow on|off` toggles: first-party skills installed into `~/.moh/skills/`
(hash-checked, `minMohVersion`-gated), a set of slash aliases built from that skill list
(`tui/src/commands.ts:147-162`, `:756-790`), and — on enable — the tracker tools are added to
the *live* session via `session.addTools?.(trackerTools(tracker))` (`commands.ts:186-190`).
`trackerTools` yields `tracker_list` (allowed by default) and `tracker_claim` (asks by default)
(`tracker.ts:386-418`), running through the ordinary permission engine. The Frontier panel and
`skillRouting` project the tracker into suggestion UI. `handoff*.ts` adds a local artifact plus
an optional gist transport gated by `moh.json` `handoff.transport` (absent = off,
`handoff.ts:22-33`).

**Trust model.** Tracker tools are built-ins of the client, not of the core: the backend is
resolved by the client (`resolveTrackerSync`), the tools ride tier-1 defaults, and permission
prompts are the only gate. Handoff publishing is gated by an explicit config value; the artifact
never leaves the machine unless the transport is set.

**Overlap — the sharpest competition in this inventory.**
- `session.addTools()` (`session/session.ts:852-856`) is a **public core method that adds tools
  to a running session**, documented as "workflow-mode toggle, #36". Its doc-comment claims
  tier-1 defaults come from `DEFAULT_TOOL_PERMISSIONS` and `moh.json` overrides apply — but a
  name not present in those tables has no default, so a client-added tool effectively lands at
  whatever the resolver does for unknown names. An extension has **no equivalent door**: the
  only tools an extension can influence are ones the client or MCP already registered.
- So today **three doors add a tool** (built-in, MCP server, client `addTools`/`SessionOverrides.tools`)
  and **zero extension seams** do. A ticket phrased as "extensions should add tools" is asking
  the platform to reach parity with a power clients already hold.

---

## 7. Subagents — `subagents.ts`, `moh.json` `agents`

**Power.** `moh.json` `agents` presets override the built-ins (`config.ts:117`), each with
`systemPrompt`, `allowedTools` (a strict subset filter), `model`/`provider`, `maxIterations`,
`context`. Children get the parent's registry minus `spawn` and minus every `mcp__*`
(`subagents.ts:230-243`), and hold their own route/serving model (ADR-0050).

**Trust model.** Project-owned and prompt-authoritative: a cloned repo's `agents` preset can
set a child's system prompt. There is no consent step (unlike extensions and MCP).

**Overlap.** A *fourth* schema-shaped extension point declared in the project file, expressed as
plain data. `allowedTools` is a restrict-only tool filter — structurally the same posture as
`veto`/`ask`, implemented as configuration. An extension has no counterpart for scoping a child
session.

---

## 8. Memory and session notes — `memory.ts`, `prompt-composer.ts`, notes skill

**Power.** `MemoryStore` writes topic files under `~/.moh/projects/<slug>/memory`, injected as a
`## Memory` prompt section capped by `memoryConfigSchema` (`memory.ts:65-72`, budget 2000 tokens
default, interval 5 turns) — rendering at `prompt-composer.ts:160`. Session notes are **a path
and nothing else**: the core renders `Session notes: <path>` in the environment section
(`prompt-composer.ts:240`) and never reads, writes or compacts the file (CONTEXT.md,
"Session notes"); the `session-memory` skill maintains it inside turns.

**Trust model.** Memory is per-project, user-dotdir, and bounded; session notes are handed to
the *model* to maintain, so their content is model-authored, not user-authored.

**Overlap.** These are **the other unbounded prose channel into the prompt** (alongside §2
skills and §9 prompt files) versus the extension's bounded `extension_notes`. The session-memory
skill demonstrates that a *skill* can implement a persistent-context feature that an extension
would reach for `appendToPrompt` to build — with the difference that the core guarantees only
the path.

---

## 9. Prompt files and instruction documents — `prompt-composer.ts`

**Power.** A full base-prompt override: `.moh/prompts/system.md` (project) < `~/.moh/prompts/system.md`
(`prompt-composer.ts:196-201`, project wins). Plus `AGENTS.md` (or `CLAUDE.md` fallback) and
`CONTEXT.md`, concatenated with a truncation notice against a shared budget
(`prompt-composer.ts:203-220`).

**Trust model.** **None.** These files are read at *compose time on every model call*
(`prompt-composer.ts:131-134`), from the repo, with no consent, no hash, no size cap beyond the
budget slice. `AGENTS.md` is exactly the file this repo uses to instruct agents.

**Overlap — the convention that makes the extension prompt doors look weak.**
- `extension_notes`/`turn_notes` are additive, capped and one-line-per-extension by design
  (`extension_notes` joins with blank lines; `turn_notes` truncates per note). `.moh/prompts/system.md`
  **replaces the base prompt outright** and `AGENTS.md` adds an unbounded block. A novel
  extension-platform proposal for "let extensions shape the prompt" must justify itself against
  a door that already does it better and without consent — that asymmetry is the finding.
- The section order is fixed (`SECTION_ORDER`, `prompt-composer.ts:15-25`) and `extension_notes`
  sits **before** `turn_notes` and after `mpm`; an extension can never reorder or replace the
  base, which is precisely what a prompt file may do.

---

## 10. Headless / embedding seams — `session/from-config.ts`, `docs/extending/library-usage.md`, `packages/cli/src/*`

**Power.** `sessionFromConfig` returns `{ session, store } | { error }` and owns moh.json
reading, MCP merge, provider resolution, subagent/memory wiring, store creation and
`createSession` (ADR-0005). The client injects:
- **consent seams** — `onPermissionRequest`, `onAskUser`, `onConfirmTurn`, `onMcpTrust`,
  `onExtensionConsent` (`from-config.ts:91-125`);
- **overrides** — a full `tools` registry, `permissions`, `permissionFlags`, `firstParty:
  include|exclude`, an extra `sink`, and an existing `store` for resume (`from-config.ts:128-150`);
- **`bundledExtensions: [source]`** (#826/ADR-0039) — `{ name, isActive, activate, inactiveNote?,
  wire? }`; the client decides activation, the core hosts it.

**Trust model.** The client is trusted by definition (it is the process). Headless clients are
fail-closed: no consent seam → "ask" calls become structured denials, project MCP servers are
skipped, an un-enabled extension is refused. The CLI (`run.ts:345`, `serve.ts:288-306`,
`compact.ts:78`) and the TUI (`factory.ts:99`) all mount the same first-party list
(`tui/src/bundled-extensions.ts:32`), imported by path from the CLI so there is one list. A
library user mounting nothing gets **no** first-party extension.

**Overlap.** This is the door where the extension platform is *appended to*, not competed with:
`bundledExtensions` and `overrides.tools` occupy the same call site. The competition is
internal to the client override surface: `SessionOverrides.tools` is a **whole-registry
replacement**, so a client can already add, rename or remove any tool — the extension runtime's
`veto`/`ask` are strictly weaker (restrict-only, ADR-0031). A third party cannot reach
`overrides.tools`; it is the client's, not the user's.

Also relevant: `moh serve` is a **closed RPC protocol v1** (`packages/cli/src/serve.ts:1-22`,
`docs/serve-protocol.md`) — an out-of-process door with no auth surface beyond stdio.

---

## Table

| door | power it grants | trust model | overlap with the extension platform |
|---|---|---|---|
| MCP servers (`mcp/runtime.ts:213-250`) | add tools (`mcp__s__t`) from an out-of-process server; 60s timeout; no schema | project servers: one-time consent, "always" → user-config `mcpTrust` (repo `trusted` ignored); user servers: trusted; headless = denied | **implements the same power** with a process boundary; tools are vetoable/askable like built-ins, except yolo lifts built-in prompts but not MCP asks, and extension asks are ignored in yolo |
| MCP refused capabilities (`runtime.ts:28-32`) | *nothing* — sampling/roots/elicitation are −32601 + `mcp_refused` | n/a | caps the richest external door to tools only; a server cannot ask the model for anything |
| Skills (`skills.ts:82-103`) | prompt-level behaviour, body loaded via `read`; turn-scoped via `skill_invoked` | **none** — a cloned repo's `.moh/skills` is live immediately | competes with `appendToPrompt`/`setPromptNote`; unbounded where the extension notes are capped |
| `skillRouting` (`skill-routing.ts:46-71`) | remap/disable label→slash-command suggestions | project config, chrome only | no extension counterpart (an extension cannot add a suggestion row) |
| Providers, config-only (`config.ts:56-87`) | any OpenAI-compatible endpoint with zero code | project may declare endpoints and inline keys (0600 forced); `auth` user-only | declarative long tail no extension hook can supply; wire-locked |
| `registerProvider` (`provider-registry.ts:56-90`) | add a provider *implementation* to the registry | program-level, pre-assembly; registry frozen per session | **grants exactly what extensions lack**: the runtime has no "add a provider" seam |
| `provider-config.ts:95-125` | user/provider layering with collision refusal | user keys outrank project on lookup | extensions have no config-merge story at all (they read config generically, ADR-0039) |
| moh.json keys (`config.ts:103-177`) | routing, permissions, agents, compaction, browser, mpm, handoff, maxIterations, `extensions` | non-strict, unknown keys stripped; standing-authority keys refused here | the *precedent* for project-proposes/user-disposes that the extension consent model reuses |
| Themes (`user-themes.ts:1-27`) | recolor the TUI | none needed — JSON cannot express code; `extends` a built-in only | the precedent for a safe non-code drop-in door |
| Icons (`tui/src/icons.ts:10-22`) | on/off glyph mode | none | none |
| *(no user keybindings)* | — | — | a door that does **not** exist; keymap is compiled in |
| Workflow mode (`commands.ts:186-190`) | installs first-party skills, adds tracker tools to a live session | built-in client tools, permission prompts only | `session.addTools` (`session.ts:852-856`) is a tool-adding door extensions cannot use |
| Tracker tools (`tracker.ts:386-418`) | `tracker_list` allow / `tracker_claim` ask | tier-1 defaults + permission engine | same permission spine as extensions; not hook-registered |
| Handoff (`handoff.ts:22-33`, `handoff*.ts`) | local artifact + optional gist publish, seed prompt for a receiving session | `handoff.transport` explicit (absent = off) | `handoffSeedPrompt` is a skill-prompt delivery path, no extension hook |
| Subagents (`subagents.ts:230-243`, `config.ts:117`) | preset child sessions: system prompt, tool subset, model | project-owned, no consent | a restrict-only tool filter implemented as data; no extension equivalent for child scoping |
| Memory (`memory.ts:65-72`) | model-authored durable facts into `## Memory` | per-project user dotdir, token-budgeted | unbounded-ish prose channel vs capped extension notes |
| Session notes (`prompt-composer.ts:240`) | a path the model maintains | core guarantees the path only | the "remember things" skill already implements what an extension would build |
| Prompt files (`prompt-composer.ts:196-220`) | replace the base prompt; add AGENTS.md/CONTEXT.md | **none** — read every call, no consent, no hash | **silently defeats** the extension prompt doors: replace-and-override where extensions are additive and capped |
| `sessionFromConfig` consent+overrides (`from-config.ts:91-150`) | inject consent, whole tool registry, permission flags, sink, store | the client *is* the trust boundary | `overrides.tools` already adds tools; extensions reach the same session via `bundledExtensions` |
| `bundledExtensions` (`from-config.ts:~300`, ADR-0039) | host first-party extension sources, client decides activation | no consent for shipped bytes; core imports no extension package | the extension platform's own mounting door |
| `moh serve` (`cli/src/serve.ts:1-22`) | drive one session over stdio JSON-RPC | none beyond stdio; protocol v1 closed | an out-of-process client door with no extension visibility |

---

## Findings to carry into #997

1. **Powers the extension platform is "supposed to add" that already exist elsewhere**: tools
   (MCP servers, `session.addTools`, `SessionOverrides.tools`, tracker tools, `mpm_query`,
   browser), prompt influence (skills, prompt files, memory, session notes, subagents'
   `systemPrompt`), provider/config extension (`openai-compat`, `registerProvider`,
   `capabilities.thinking`), assets (themes), and activation-by-config
   (`moh.json` keys, `agents` presets).
2. **Doors that conflict with / silently defeat the extension platform's teeth**:
   - `.moh/prompts/system.md` + `AGENTS.md` replace/extend the prompt with **no consent and no
     cap**, while `extension_notes` and `turn_notes` are additive, truncated and per-extension.
   - `SessionOverrides.tools` (client) and `session.addTools` replace/add tools wholesale;
     extensions can only `veto`/`ask` tools someone else registered — they can never add one.
   - `registerProvider` grants provider registration to a program, and there is no
     extension-facing counterpart.
   - `moh.json` `agents` presets set a child session's system prompt and tool subset with no
     consent step — an unreviewed, repo-controlled, prompt-authoritative surface that no
     extension can reach.
   - yolo asymmetry: MCP asks survive, extension `ask` does not (`permission-gate.ts:88-104`).
3. **Trust models are inconsistent across doors** and worth stating explicitly in #997: none
   (skills, prompt files, themes), one-time consent + content hash (extensions), one-time
   consent + project-slug persistence (MCP), user-config-only (typesafe, auth, mcpTrust),
   client-trusted (sessionFromConfig overrides). The extension platform's file+hash model is
   the strictest *for code*; the *data* doors are wide open.
4. **UNVERIFIED**: (a) the exact default permission resolution for a tool name added by
   `addTools` that is absent from `DEFAULT_TOOL_PERMISSIONS` (starred in §6 as a doc-comment
   claim; not traced into `permissions.ts`); (b) whether `SessionOverrides.tools` fully replaces
   or merges with the built-in registry (the doc string says "Full tool registry …, default:
   built-ins"); (c) whether any TUI surface allows a user — not just a client — to supply a tool
   registry.
