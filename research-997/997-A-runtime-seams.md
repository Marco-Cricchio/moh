# 997-A — The extension runtime as it exists today (inventory for #997)

Tree HEAD `ff4a5ebd`. Every claim carries a `file:line` citation. "Contract" = `packages/extension/src/index.ts`
(types-only, `MOH_EXTENSION_API_VERSION = "1.9"`, index.ts:82); "runtime" = `packages/core/src/extensions.ts`
(class `ExtensionRuntime`, :371). This is the inventory for ticket #997 ("Define the complete extension
platform contract", child of map #996). It records what the *runtime* enforces; docs are quoted only where
they disagree with the code (§9).

## 1. Discovery and load order

Two doors into one runtime, plus one door only clients can walk.

- **Door A — the user dotdir.** `extensionSourceFiles()` reads `<mohHome>/extensions/`, keeps entries that are
  files or symlinks and end in `.ts/.mts/.js/.mjs` (hidden names and `.d.ts` excluded), **sorted by name**
  (extension-source.ts:26-33, 46-77). The directory is read with `readdirSync`; an unreadable directory reads
  as "no extensions", never a session error (extension-source.ts:64-70). No recursion: the filter requires
  `entry.isFile()` (extension-source.ts:64), so a subdirectory is not a source.
- **Door B — the project's `moh.json`.** `config.extensions` is a validated `string[]` (config.ts:117),
  resolved *relative to the project root* unless absolute, appended **in declaration order after the dotdir**
  (extension-source.ts:78-85). The project **proposes**: a declaration is only a path handed to the same
  content-bound consent as any dotdir file (extension-source.ts:15-19; docs/extending/extensions.md:558-571).
- **The order is the contract, not an implementation detail**: hook precedence is registration order, and
  `registerFiles()` loads the list sequentially as one pending registration (extensions.ts:742-753).
- **Canonicalization + dedup**: every path goes through `canonicalModulePath()` (`realpathSync`, falls back to
  the given path), and the resolved list is deduplicated by that canonical path — one file reached by two
  spellings loads once (extension-source.ts:56-84; extensions.ts:335-342).
- **Where the resolution happens, and for whom**: `sessionFromConfig` resolves both doors for *every* client,
  in the one assembly path (from-config.ts:253-256, ADR-0005), then creates one `ExtensionRuntime` and fires
  `registerFiles` without awaiting (from-config.ts:268-325). `AgentSession` awaits `ready()` before its first
  turn and calls `startWatch()` then (session.ts:787-800) — so a consent prompt is answered before any hook
  can run.
- **Door C — bundled sources** (a *different* door, not a discovery source): `bundledExtensions` on
  `sessionFromConfig` (from-config.ts:175, 268-294) takes `MountedBundledExtension { source, active }`
  (bundled-extensions.ts:123-131) and registers them with `{ bundled: true }` (bundled-extensions.ts:161).
  The core imports no extension package; the first-party list lives in the client
  (`packages/tui/src/bundled-extensions.ts:36-45`, mounted by `packages/tui/src/factory.ts:99`,
  `packages/cli/src/run.ts:345`, `serve.ts:291`, `compact.ts:78`). A client that mounts none assembles a
  session with no bundled extension at all.
- **What a project may not do**: it cannot activate anything by itself (no field in `moh.json` skips consent),
  and nothing is auto-discovered from a project directory — there is no "project extensions/" convention in
  the code (extension-source.ts:15-19).

## 2. Consent

- **One-time enable question, bound to content identity.** `contentIdentity(file)` = canonical path + `: ` +
  SHA-256 of the file's bytes (extensions.ts:345-353). In-memory definitions have no bytes and keep the
  historical name identity `memory:<name>` (extensions.ts:955).
- **Asked before import, always.** `#registerFileNow` computes the identity and calls `#ensureConsent` *before*
  `importDefinition()` (extensions.ts:806-828): importing evaluates the module, so a declined or never-asked
  file executes nothing (extensions.ts:776-780).
- **Store**: `<mohHome>/extensions.json`, `consents: {"<path>:<sha256>": true}` and
  `dependencies: {"<path>:<sha256>": [...]}`; written 0600 inside the moh home, mkdir 0700
  (extensions.ts:212-217, 1152-1167). A malformed/unreadable store reads as empty (extensions.ts:1152-1160).
- **What invalidates it**: any byte change (the hash is half the key) — a re-ask names the previous instance's
  name/version so the prompt can say *which* extension changed (extensions.ts:859-878, ExtensionsConsentRequest
  docs extensions.ts:82-93). Also: a *different spelling of the same file does not invalidate it*
  (canonical path, extensions.ts:335-342). A changed `dependencies` list does not re-ask consent; it goes
  through the second gate (§3).
- **Bundled code skips it entirely**: `if (bundled) return { ok: true }` (extensions.ts:781-782).
- **Headless fails closed**: no `consent` seam → refusal with `reason: "consent"` and one `onWarning` line on
  stderr (extensions.ts:783-790); a declined answer → `reason: "consent"` (extensions.ts:795); a throwing
  consent callback → `reason: "consent"` (extensions.ts:792-793). The session continues either way.
- **Which clients can ask**: only the TUI — `factory.ts:100-140` maps `onExtensionConsent` onto the permission
  modal under `EXTENSION_CONSENT_TOOL = "extension"`, and only an explicit `"yes"` enables (factory.ts:132-136).
  The modal line says "no sandbox: it runs with moh's own privileges" (permission-gate.ts:139). `moh run`,
  `moh serve` and `moh compact` pass **no** `onExtensionConsent` (run.ts:345-351, serve.ts:291-306,
  compact.ts:77-84) — they *do* pass `consent.onPermissionRequest`/`onConfirmTurn` for other seams, which makes
  the absence of the extension seam explicit rather than an oversight. A library user embedding
  `sessionFromConfig` decides for itself.

## 3. Dependencies

- `ExtensionDefinition.dependencies?: string[]` — "npm specs moh installs for the extension, with per-change
  authorization" (index.ts:391, 490-493).
- **Where install happens: nowhere.** The refusal is the honest v1 answer: if `deps.length > 0` and the host
  has no `authorizeDependencies` seam, the load fails with `reason: "deps_unauthorized"`,
  message "…and this host cannot install them" (extensions.ts:972-979). No `install`/`bun add` call site exists
  anywhere in the load path (`ExtensionRuntimeOptions` carries `consent`, `authorizeDependencies`,
  `onWarning`, `requestTurn` only — extensions.ts:95-130).
- With a seam: a changed list asks; `true` persists the list against the same content identity, `false` refuses
  (extensions.ts:980-992). An unchanged list never re-asks (extensions.ts:972). Bundled definitions skip the
  gate (extensions.ts:972).
- **Isolation: none.** No node_modules root, no resolution path, no process boundary is created or enforced for
  an extension. A dependency the extension already finds on disk (hoisted, global, or a plain relative import)
  is simply imported by the module itself; only the *declaration* is gated — and it currently only ever leads
  to a refusal. docs/extending/extensions.md:583-586 states the v1 position ("not installed yet").

## 4. Hot-reload, and the absent dev-folder trust

- Watched at session start, after `ready()`, for every instance loaded from a file (session.ts:787-800 →
  `startWatch()`, extensions.ts:830-838). `fs.watch` on the file, debounced 100 ms (extensions.ts:847-857).
  Bundled definitions have no `file` and are never watched.
- Reload = re-consent edited bytes **before** re-import (extensions.ts:864-878), re-import cache-busted
  (extensions.ts:365-368), `#instantiate(def, file, previous.state)` so `setup()` sees the previous state
  (extensions.ts:891-892, index.ts:401-402). Hooks are rebuilt by the new `setup()`. The instance is replaced
  in place (extensions.ts:896-908), and a published status is cleared first because a status is a statement
  about *now* (extensions.ts:902-905).
- Failure posture: previous instance is kept and `reason: "reload_failed"` is emitted, on both channels (log +
  `onWarning`) (extensions.ts:876-899). The synthetic-turn streak is keyed by extension **name**, so a reload
  cannot refill the correction budget (extensions.ts:402-406).
- **Development-folder trust does not exist.** Evidence: (a) trust is only ever granted by
  `RegisterOptions.bundled` or by a stored content identity (extensions.ts:131-137, 777-795) — there is no
  path-prefix, `NODE_ENV`, `--dev`, or `trusted` field anywhere: `grep -rn "dev\|trusted" packages/core/src/extensions.ts`
  yields nothing on the load path. (b) Every path-loaded module — including one living inside the project's
  own `extensions/` folder — goes through `#ensureConsent` with `bundled=false` (extensions.ts:806-811,
  864-866). (c) The TUI's only consent answer is the modal's explicit `"yes"` (factory.ts:132-136); the repo's
  precedent (`mcpTrust`, the repo's own `trusted` field ignored) is cited as the reason
  (extension-source.ts:16-19, docs/manual/extensions.md:56-58). So today an author iterating on an extension
  re-answers a modal prompt on every edit — there is no trust-on-first-use per directory, and no "trust this
  folder" gesture.

## 5. Powers of `setup(ctx)` — the complete list

Contract: `ExtensionSetupContext`, index.ts:397-481. Nine hook registrations + `state` + six methods.

| Power | What it does | Restriction semantics | Failure policy / caps |
| --- | --- | --- | --- |
| `state` | per-extension object, seeded from the previous instance on hot-reload (index.ts:398-400; extensions.ts:1004) | none — but it is **per runtime, not per session** (index.ts:127-147; docs:162-190) | never validated; nothing clears it |
| `appendToPrompt(note)` | pushes onto `notes[]`, rendered as the trailing `extension_notes` section (index.ts:401; prompt-composer.ts:162-163; extensions.ts:416-418, 1006) | append-only, durable, no clear/replace (docs:449-455) | never truncated at set time; permanent for the session |
| `setPromptNote(text\|null)` | one per-turn note, `turn_notes` section (index.ts:408-425; extensions.ts:1007-1009) | one per extension, replacing; never touches system prompt, project instructions or another extension's note | cleared at the start of every turn in `dispatchBeforeTurn` (extensions.ts:1199-1201); oversized notes truncated by the core with a marker (prompt-composer.ts:165-168) |
| `setStatus(text\|null)` | ephemeral footer status (index.ts:426-432; extensions.ts:1114-1125) | one per extension, replaced; never logged | cleared at session end and on reload (extensions.ts:910-913); headless = one stderr line, exit code untouched; on event-cap exhaustion it is overlaid with the degraded text (extensions.ts:611-628) |
| `appendEvent({name,payload?})` | one `extension_event` chrome entry (index.ts:402-407; extensions.ts:1041-1112) | observation only: never permissions, never model context; the runtime stamps the emitter name, so impersonation is impossible | non-empty name required (extensions.ts:1048-1051); payload must be JSON-serializable and ≤ 8 KiB, **8 * 1024** = 8192 (extensions.ts:1054-1078, 308) — dropped, never truncated; **50 per extension per session per turn** (extensions.ts:1087-1105, 298) with one `event_cap` warning + status overlay; structural redaction of 14 normalized key names to depth 6 (extensions.ts:278-331) |
| `requestTurn(text)` | core-mediated synthetic turn (index.ts:466-481; extensions.ts:646-681) | text only, never model-generated; no `beforeTurn` hooks for it; tool calls gated normally | **max 2 consecutive** per extension name (`MAX_CONSECUTIVE_SYNTHETIC_TURNS`, extensions.ts:172, 663-670), reset only by a real user turn (`noteRealTurn`, extensions.ts:640-644); refusals always visible as `extension_failed { reason: "request_turn" }`; resolves `true/false` |
| `onSessionStart` | once at session start (index.ts:433; session.ts:793-800) | observe | throws → `extension_failed { reason: "hook" }` via `#each` (extensions.ts:1494-1506) |
| `onSessionEnd` | once, on dispose, with `reason` (index.ts:434; extensions.ts:1179-1182) | observe | same |
| `beforeTurn` | turn-start decision point (index.ts:435-440; extensions.ts:1191-1234) | restriction-shaped only: name an **existing** model ref (resolved like `/model`) or ask `confirm`; never a grant, never an invented model | exclusive decision: **first** hook returning each field wins, in registration order (extensions.ts:1206-1230); throw → fail-open `hook` error; an unresolvable ref → `extension_failed { reason: "invalid_model" }` and the turn proceeds on the active model (agent-loop.ts:592-599). The `confirm` reaches the user via the client seam; nothing can ask → `refuse` (agent-loop.ts:575-584; `resolveTurnConfirm`, extensions.ts:260) |
| `beforeModelCall` | read-only: assembled prompt sections/system + messages (index.ts:100-108, 441) | read-only, no return value | throw → fail-open `hook` |
| `onToolCall` | veto/ask a tool call (index.ts:442, 239-256; extensions.ts:1478-1501) | **restrict-only**: `veto` outranks user rules, defaults and yolo; `ask` hands the call to human consent and is explicitly *not* a grant (never writes a rule, no "always") | first decision wins, registration order; `veto` beats `ask`; throw → fail-open; `ask` degrades to denial headless (index.ts:247-250; docs:243-263) |
| `onToolResult(tools[], hook)` | post-settlement inspection of a tool's text output (index.ts:443-450; extensions.ts:1247-1295) | scope is explicit per tool name — an empty list registers nothing (extensions.ts:1017-1020); one outcome `withhold` (refusal-shaped replacement), never rewrite/truncate/redact; images are never offered (index.ts:196-205) | every matching hook runs; **first withhold wins**; throw or reason-less withhold → fail-open, original result proceeds (extensions.ts:1260-1290) |
| `onCompaction(hook)` | drop sections from a compaction's input (index.ts:451-460; extensions.ts:1311-1413) | may only *remove* offered section ids; user messages and chrome are structurally absent; core enforces a **60% survival floor** (index.ts:326-336; compaction.ts:861-880) | **the only turn-path hook with a timeout**: default **5 s**, `hookTimeoutMs = 5_000` (extensions.ts:1318), per hook, raced with the promise, `AbortSignal` fired on abandonment (extensions.ts:1336-1380); timeout → `hook` error, no drops, and a late answer still gets `applied: false` (extensions.ts:1340-1367); unknown id → `unknown_section`; floor bite → `section_floor` from the runner (compaction.ts:875-878) |
| `onEvent` | every appended event, except `extension_failed` (index.ts:461; extensions.ts:1415-1431) | observe; `extension_control` reaches the named extension alone (extensions.ts:1420-1426) | serial dispatch queue with reentrancy guard (event-log.ts:443-460); `extension_failed` is never re-dispatched (event-log.ts:374-377) — this is the real "terminal" that docs/extending/extensions.md:636 mis-describes (§9) |
| `afterTurn` | turn outcome `{status, reason?, message?}` + `synthetic` flag (index.ts:370-380, 462) | observe | throw → fail-open `hook` |

**No turn-path hook has a timeout except `onCompaction`.** `#each` awaits every hook with no deadline
(extensions.ts:1494-1506); `dispatchBeforeTurn`/`checkToolHooks`/`checkToolResultHooks` likewise
(extensions.ts:1191-1234, 1478-1501, 1247-1295). A hung `beforeModelCall` or `onToolCall` stalls the turn
indefinitely — the compaction watchdog (extensions.ts:1318) has no analogue elsewhere.

## 6. NON-powers — each with the enforcing code

| Not possible today | Enforcing code |
| --- | --- |
| **Add a tool** | `ExtensionSetupContext` exposes no tool registration (index.ts:397-481); tools reach a session through `overrides.tools` owned by the client (session/config.ts:157-170), never through the runtime — `ExtensionRuntime` has no tools field (extensions.ts:371-420) |
| **Add a slash command** | slash commands are client-side (`packages/tui/src/commands.ts`); the only extension → client channel is `setStatus` (extensions.ts:1114) and the only client → extension channel is `extension_control` by name (session.ts:1215) |
| **Register a provider** | providers are resolved in assembly (`resolveProvider`/`resolveProviderRef`, from-config.ts:229-238); no seam in the extension contract touches a registry or an endpoint profile |
| **Touch the system prompt beyond the two doors** | the composer's section table has exactly two extension-owned sections, `extension_notes` and `turn_notes` (prompt-composer.ts:162-169); both are additive strings (extensions.ts:1006-1009) |
| **Write a permission rule** | an extension can only `veto`/`ask`/`withhold`; `ask` explicitly "never writes a permission rule" (index.ts:247-250, 239-256) and permission-gate.ts:123-126 states the consent ask "can never write a rule" |
| **Spawn a subagent** | subagents are assembled from `moh.json` `agents` presets and the subagent tool (config.ts:126), not exposed through `ctx`; a child merely *borrows* the parent's runtime (extensions.ts:466-489, index.ts:127-147) |
| **Read/write session files** | `AgentSession` owns `#sessionFile` privately (session.ts:1190-1193); no extension-facing accessor exists, and `sessionFromConfig`'s return object hands out `{ session, store }` only (from-config.ts, ADR-0005) |
| **UI beyond the footer status** | `setStatus` is the entire UI surface (index.ts:426-432); the TUI consumes it through `onStatusChange`/`statuses()` (extensions.ts:485-503) |
| **Initiate a turn unprompted** | `requestTurn` is the only door and it is core-mediated, capped at 2 consecutive (extensions.ts:651-670); no scheduler/wakeup seam exists |
| **Any sandbox, filesystem, or network restriction on the extension's own code** | stated at the source: "Everything loaded here is arbitrary in-process code … **There is no sandbox: an extension runs with the same privileges as moh**" (extension-source.ts:20-22); the TUI says it in the consent prompt (permission-gate.ts:139); the manual repeats it (docs/manual/extensions.md:100-107). Nothing in `extensions.ts` wraps the module: `importDefinition` is a plain cache-busted dynamic import (extensions.ts:365-368) |

## 7. Failure and observability

- **`extension_failed` reasons in use**: `consent` (extensions.ts:782, 793, 795), `load_failed`
  (extensions.ts:813, 823), `invalid` (extensions.ts:935, 940), `api_version_mismatch` (extensions.ts:947),
  `deps_unauthorized` (extensions.ts:978, 985, 988), `setup_failed` (extensions.ts:1032), `hook`
  (extensions.ts:1218, 1270, 1376, 1455, 1487), `invalid_event` (extensions.ts:1050, 1066, 1077),
  `event_cap` (extensions.ts:1100), `invalid_withhold` (extensions.ts:1283), `unknown_section`
  (extensions.ts:1397), `request_turn` (extensions.ts:659, 667, 674), `reload_failed` (extensions.ts:877, 889,
  898), `invalid_model` (agent-loop.ts:596), `missing_on_resume` (session.ts:826), and `section_floor`, emitted
  by the compaction runner under the name `"compaction"` (compaction.ts:875-878).
- **`extension_event`**: chrome, never model context, never a turn error (types.ts:380; index.ts:402-407).
  Caps and redaction as in §5. Each record is one dim transcript line.
- **`extension_control` — who emits it today**: `AgentSession.setExtensionState(extension, payload)` appends it
  through the normal path (session.ts:1206-1217) and `extensionState(extension, name)` reads back a value from
  an extension's own `state` (session.ts:1232-1234). Delivery is name-targeted
  (extensions.ts:1420-1426), and `extension_failed`-class events are excluded from dispatch, so a control
  command cannot be answered by a loop. **Only one first-party emitter/consumer pair exists today**: the TUI's
  `/routing` control path (`packages/tui/src/jev-control.ts:30-34` → `setExtensionState(JEV_EXTENSION_NAME,
  {cmd:"usecase", …})`) consumed by `packages/jev-guard/src/index.ts:766`; the TUI reads back through
  `session.extensionState(...)` (App.tsx:689). No CLI surface emits it.
- **Other chrome**: `extension_loaded` (extensions.ts:908, 918) is the name/version announcement a RESUMED
  session reconciles against; `statuses()` is the footer projection (extensions.ts:493-503); `onWarning` is the
  non-log channel (headless stderr) for the cases where nobody reads a log (extensions.ts:113-117, 783-790).
- **Attribution**: `appendEvent` and hook errors land in the *dispatching* session's log — a subagent child's
  `appendEvent` never touches the parent's channel (extensions.ts:466-489, 1127-1140, `SessionScope`
  extensions.ts:143-155).

## 8. apiVersion policy as implemented

- Host speaks `"1.9"` (index.ts:82). Policy: **additive-only within a major**; a major mismatch refuses the
  load with `api_version_mismatch` and the session continues (index.ts:9-11, 940-951). `parseApiVersion`
  requires exactly `major.minor` (index.ts:504-509); a malformed value is `invalid` (extensions.ts:939-941).
- Minor gaps are fail-open in both directions (index.ts:12-76, one paragraph per minor): a new context method
  is simply absent (guard with `typeof ctx.requestTurn === "function"`, index.ts:474-479), an unknown outcome
  key is ignored, an old runtime never calls a new hook.
- The runtime never reads the minor number for behaviour: only `api.major !== host.major` is tested
  (extensions.ts:947). Capabilities are therefore discovered by *feature presence*, which is why several
  contract fields are optional and documented as "absent on a runtime older than X"
  (index.ts:277-296, 313-318).
- A mismatch detected at hot-reload keeps the previous instance (extensions.ts:894-899).
- Guidance authors get: the versioning table and per-minor changelog in docs/extending/extensions.md:521-548,
  the mandatory `apiVersion` field in `defineExtension` (index.ts:483-497), and the MOH_EXTENSION_API_VERSION
  constant to import (index.ts:78-82).

## 9. Dead ends and inconsistencies

1. **"An extension whose dispatch throws is marked failed terminally and never re-dispatched"**
   (docs/extending/extensions.md:634-637; CONTEXT.md:99 says the same). No such marking exists: a throwing hook
   produces one `extension_failed { reason: "hook" }` and `#each` keeps iterating the remaining hooks and
   instances (extensions.ts:1494-1506); the next turn dispatches the same extension again. The only real
   terminal rule is smaller and lives elsewhere: `extension_failed` events are never fed back to `onEvent`
   (event-log.ts:374-377). The docs describe a runtime that does not exist.
2. **`isActive` vs the code.** ADR-0039's residual is recorded as removed, and the code agrees:
   `MountedBundledExtension { source, active }` + client-side `evaluateActive` (bundled-extensions.ts:96-131,
   tui/bundled-extensions.ts:36-45). **This is confirmed stale in-tree**: CONTEXT.md:31 still defines a bundled source as
   `{ name, isActive(readConfig, configFile), activate(...), ... }` and says "the core asks the *extension* whether it
   is active", while ADR-0039:101-120 records that deviation as **removed**, the code matches the ADR
   (bundled-extensions.ts:96-131, 149-170) and docs/extending/extensions.md:604-611 documents only
   `evaluateActive` on the source. CONTEXT.md:31 is the one live disagreement, not the docs chapter.
3. **`dependencies` is documented as "installed by the host"** (docs/extending/extensions.md:75-77, index.ts:490)
   while the code refuses every non-empty list on every host that ships today (extensions.ts:972-979). The
   manual states the honest version (docs/manual/extensions.md:56-58, docs/extending:583-586); the contract
   docstring still advertises an install that does not happen. This is the intended-power TODO of the set.
4. **No timeout on any turn-path hook but `onCompaction`** (§5): the docs teach a hook author to budget against
   `hookTimeoutMs` only for compaction (docs/extending/extensions.md:384-390), and say nothing about the fact
   that a hung `onToolCall` blocks the turn indefinitely. Asymmetry worth naming in #997.
5. **The event cap's scope churned twice** and the prose lags in places: it is now per *session* per turn, keyed
   by `SessionScope.id`/owner id (extensions.ts:190-217, 1087-1105), but the constant's comment still says
   "per extension, per session, per turn" while the budget key is a session and the 50 is per instance
   (extensions.ts:297-298). One extension can spend 50 events in a turn; two extensions get 100 — the doc
   phrasing "per extension per session per turn" (docs/extending/extensions.md:421-437) is right, the const
   comment is loose.
6. **No dev-folder trust, and no plan for one in the code**: §4 shows every project-path load re-asks on every
   edit. If #997 wants a development workflow, it is a new capability, not an existing one to document.
7. **A prompt door asymmetry**: `appendToPrompt` has no clear/replace and is never truncated at set time
   (extensions.ts:1006), while `setPromptNote` is per-turn and truncating (extensions.ts:1007-1009,
   prompt-composer.ts:165-168). An extension can therefore permanently enlarge every prompt of a session with
   no way to withdraw it.

## 10. Capability matrix

| power | exposed where (file:line) | restriction / what it can never do |
| --- | --- | --- |
| discover sources | extension-source.ts:46-84 | dotdir + `moh.json` order fixed; no project auto-discovery, no recursion; project cannot self-activate |
| bundled mount | bundled-extensions.ts:123-131, 149-170; from-config.ts:268-294 | client-only; core imports no extension package; `active` decided client-side |
| consent | extensions.ts:776-796; from-config.ts:258-278; factory.ts:100-140 | bound to canonical path + SHA-256; asked before import; headless refuses; TUI-only seam; no "always" |
| dependencies | extensions.ts:972-992; index.ts:490 | refused (`deps_unauthorized`) on every shipping host; no install; no isolation of any kind |
| hot-reload | extensions.ts:830-908; session.ts:787-800 | per file, debounced 100 ms; failure keeps the previous instance; re-asks consent on edited bytes; **no dev-folder trust** |
| `state` | index.ts:398-400; extensions.ts:1004 | per runtime, not per session — shared with subagent children |
| `appendToPrompt` | index.ts:401; extensions.ts:1006; prompt-composer.ts:162 | `extension_notes` only; durable, append-only, never clearable |
| `setPromptNote` | index.ts:408-425; extensions.ts:1007-1009; prompt-composer.ts:165-168 | `turn_notes` only; one per extension; cleared each turn; truncated when oversized |
| `setStatus` | index.ts:426-432; extensions.ts:1114-1125 | footer only; ephemeral; one per extension; never logged; cap-degradation overlay |
| `appendEvent` | index.ts:402-407; extensions.ts:1041-1112 | name/payload caps (8 KiB, JSON-serializable, dropped not truncated); 50 per session per turn; redaction to depth 6; chrome only |
| `requestTurn` | index.ts:466-481; extensions.ts:646-681 | core-mediated text only; 2 consecutive; refusals never silent; no `beforeTurn` re-check |
| 9 hooks | index.ts:433-462; extensions.ts:1170-1506 | observe; restrict-only (`veto`/`ask`/`withhold`/`drop`); first-decision-wins (except `onToolResult`/`onCompaction`); fail-open on throw; only `onCompaction` has a 5 s window |
| `extension_control` (inbound) | session.ts:1206-1232; extensions.ts:1420-1426; tui/jev-control.ts:30-34 | client → one named extension; opaque payload; unknown name is a no-op; no CLI emitter today |
| `extensionState` (read-back) | session.ts:1232-1234 | opaque value from an extension's `state`; no write, no session-file access |
| no sandbox | extension-source.ts:20-22; permission-gate.ts:139; docs/manual/extensions.md:100-107 | extension code has moh's own privileges: config, credentials, network, filesystem — consent is the whole boundary |
