# 997-C — moh's client surfaces from the point of view of a UI extension

Subject: what a **UI extension** can reach today in moh's clients (TUI, CLI, headless/JSON), and where
a UI extension *protocol* would have to attach. Feeds wayfinder ticket #997 (map #996).
Tree: HEAD `ff4a5ebd`. Line numbers verified against that tree.

Terms: "extension" = a module on the `@moh/extension` contract (phase hooks, ADR-0031/0032/0038),
registered by the core at session assembly. "UI extension" = an extension that wants to touch the
*client's* surface (a command, a panel, a key, a footer chip) rather than the loop.

---

## 1. The TUI command surface

**One static registry, compiled in.** `BASE_COMMANDS` is a frozen-in-source array of `SlashCommand`
objects (`packages/tui/src/commands.ts:732`), each `{ name, description, usage?, run(ctx, args) }`
(`commands.ts:141-146`). It ships `/ask`, `/browser`, `/commands`, `/compact`, `/copy`, `/fork`,
`/help`, `/jev`, `/mode`, `/model`, `/mpm`, `/reload`, `/rename`, `/routing`, `/session`,
`/settings`, `/theme`, `/thinking`, `/tree`, `/wayfinder`, `/workflow`.

**Workflow-only aliases are generated, not registered.** `ALIASES` (`commands.ts:148`) is a
`{name, skill}` list; `workflowCommands()` maps it into `SlashCommand`s that each call
`ctx.session.send(...)` (`commands.ts:757-800`). The gate is one ternary:
`activeCommands(ctx) = workflow.enabled ? [...BASE_COMMANDS, ...workflowCommands()] : [...BASE_COMMANDS]`
(`commands.ts:808-810`). `/wayfinder` is different in kind: it is a *base* command whose `run`
self-gates on `ctx.config.workflow.enabled` and otherwise toasts (`commands.ts:666-674`).

**How `/skill-name` becomes a prompt.** Two shapes, decided by the skill body:
- body carries argument placeholders (`$1`, `${name}`) → `session.send("/<name> …", { prompt: {name, text}, args })`
  — a turn-scoped skill prompt (ADR-0011) attached to the send (`commands.ts:769-780`);
- body has no placeholders → the plain-text invocation `Load the "<skill>" skill (read its SKILL.md) and follow it.`
  goes out as an ordinary user message (`commands.ts:790-793`).

**Dispatch.** `runSlashCommand(text, ctx)` (`commands.ts:843`): a leading `/`, split on whitespace,
`activeCommands(ctx).find(name)`; unknown name → `false` and the text goes to the model. The popup
list is `commandEntries(ctx)` (`commands.ts:823`), an alphabetically sorted projection carrying a
`custom: boolean` provenance marker for the `[s]`/`[u]` chip.

**Is the list extensible at runtime? Honestly: no.** `activeCommands` reads exactly two things —
the module-level `BASE_COMMANDS` array and `ctx.config.workflow.enabled` (`commands.ts:808-810`).
There is no `registerCommand`, no command contributed by a config file, and no command contributed
by a loaded extension: the `@moh/extension` context handed to extensions exposes hooks, `appendEvent`
and `setStatus` (`packages/core/src/extensions.ts:1010-1011`) — no client registry. A user can add
*authored text* today only by writing a skill (an alias exists per first-party skill; third-party
skill aliases are not in `ALIASES`). The one piece of evidence of *intent without implementation* is
`CUSTOM_COMMAND_NAMES` (`commands.ts:837`) — a hardcoded, **empty** `ReadonlySet<string>` whose
doc comment describes a `[u]` category (moh.json `agents` presets / user aliases) that nothing
populates. It is a reserved third-party marker with no producer.

## 2. UI composition

**Tree.** `App` owns everything: session, overlay state, key handling, and the render tree
(`packages/tui/src/App.tsx:127-…`). Inside it: `Chat` (composer + tripwire input,
`packages/tui/src/Chat.tsx`), `BottomBar` (footer),
`transcript.tsx` (event-log → blocks), plus one component per modal/panel
(`Home.tsx`, `SettingsPanel.tsx`, `ModelPickerModal.tsx`, `MpmModal.tsx`, `TreePanel.tsx`,
`JevModal.tsx`, `Frontier.tsx`, `ManualModal.tsx`, `SkillChooser.tsx`, …).

**Overlays are a closed union, rendered by hand-written branches.**
`type Overlay = null | "settings" | "commands" | "manual" | "onboarding" | "handoff-onboarding" |
"workflow-offer" | "frontier" | "skill-chooser" | "model" | "skill-updates" | "quota" | "rename" |
"cold-wizard" | "tree" | "mpm" | "session" | "jev" | "browser"` (`App.tsx:127`). Each member is
matched by a literal `{overlay === "x" && <Component … />}` line in the render tree
(`App.tsx:1640-1870`, e.g. `App.tsx:1649` commands, `App.tsx:1685` manual, `App.tsx:1830` frontier).
Adding a panel is adding a union member *and* an `&&` branch: no table, no registration.

**Blocks derive from the event log, in-app.** The projection lives only in the TUI
(`transcript.tsx:974` → case-by-case `blocks.push(...)`). Its terminator is an
**exhaustive switch that throws**:
```ts
default: { const exhaustive: never = event;
           throw new Error(`unhandled AgentEvent: ${JSON.stringify(exhaustive)}`); }   // transcript.tsx:1094-1096
```
Consequence for a protocol: an extension cannot invent a new `AgentEvent` — a new event type either
gets a `case` in `transcript.tsx` or it crashes the TUI at render. The generic carrier that *does*
exist is `extension_event` (ADR-0032), whose payload is opaque to the core
(`packages/core/src/types.ts:372-380`) and which the TUI renders as one subdued chrome line (the
`extension_event`/`extension_control` cases, `transcript.tsx:974-985`).

**Seams that exist, and who can use them:**

| chrome | seam | reachable by an extension? |
|---|---|---|
| footer statuses | `ctx.setStatus(text\|null)` → runtime store (`extensions.ts:1117`) → `session.extensionStatuses()` (`packages/core/src/session/session.ts:1526`) → polled every 2 s (`App.tsx:654-672`) → chip in `BottomBar.tsx:435` | **yes** — the only write-capable chrome seam an extension has |
| transcript chrome line | `ctx.appendEvent(name, payload?)` (`extensions.ts:1010`) → `extension_event` → one chrome block (`transcript.tsx:974`) | **yes**, text-only, capped and redacted |
| modal / panel | `type Overlay` (`App.tsx:127`) + `&&` branch | **no** — every panel is moh source |
| JevModal (a third-party extension's own panel) | `packages/tui/src/JevModal.tsx`, opened by `ctrl+…`/"jev" in the TUI's own key handler | **no** — the panel is TUI source *for* one extension; there is no panel slot |
| Frontier (`App.tsx:1830`, `Frontier.tsx`) | workflow-gated, opened from `/wayfinder` (`commands.ts:666`) or `ctrl+f` (`App.tsx:1322`) | **no** — moh-owned panel for a moh-owned skill |
| ManualModal (`ManualModal.tsx`) | reads `manualIndex`/`manualPage` from `@moh/core` (bundled pages, ADR-0013) | **no** — the content seam is core-side and fixed to shipped pages |
| theme colors | user JSON themes: `themes.ts:25`, loader `user-themes.ts:78` — every token except `label` is editable, flattened over a base preset | **partially** — a *user* can author a theme JSON in the moh dotdir; an extension cannot inject one |
| footer *slots* other than status | `BottomBar.tsx:435` renders mpm, memory, extensions, jev, warnings — each a hardcoded prop | **no** |

## 3. Keybindings

**Hardcoded, per component.** Every interactive component calls Ink's `useInput` with an inline
handler: `App.tsx:1208` (global: ctrl+c exit, ctrl+r rename, ctrl+s settings, ctrl+k commands,
ctrl+h manual, ctrl+f frontier, ctrl+q quota, ctrl+b browser…, lines 1228-1344), `Chat.tsx:1125`
(esc/esc esc steering, ctrl+o, ctrl+d…), `Home.tsx:244` (list navigation, rename edit), and one
`useInput` in each of ~25 other components (`AskUserBlock`, `CommandsPanel`, `Frontier`,
`JevModal`, `ManualModal`, `ModelPickerModal`, `PermissionModal`, `SettingsPanel`, `TreePanel`, …).

**There is no binding table.** The only "registry" is the *documentation* array `COMMANDS` in
`CommandsPanel.tsx:14+` — a hand-written `{area, keys: [[key, description]]}` list rendered by `?`.
It is not consulted by any handler; changing a binding means editing the handler *and* this list.

**Can a user or extension add a key today? No.** No config key maps a key to an action
(`packages/core/src/config.ts:108-117+` has `provider`, `endpoints`, `permissions`, `extensions`,
`mcpServers`, `agents`, `memory`, … — none for keybindings), and an extension has no handle on the
Ink instance or the input loop. The only user-configurable keyboard-adjacent knob found is
`homeListMax` (`packages/tui/src/viewport.ts:29`), a list *height*, not a binding.

## 4. The control channel (ADR-0038)

**Client → extension.** `AgentSession.setExtensionState(extension, payload)`
(`session.ts:1215`) appends an `extension_control` event (chrome, payload opaque to the core,
JSON-serializable — `packages/core/src/types.ts:381-389`); the runtime dispatches it to the named
extension's `onEvent` hooks alone (`extensions.ts:1423-1428`: the runtime looks up `#instances` by `def.name` and dispatches to that instance alone). Naming an
unregistered extension is *not* an error: the log records what was asked and nobody receives it.

**The only emitter today is one line of TUI code**: `setJevUseCase` → `session.setExtensionState(JEV_EXTENSION_NAME, { cmd: "usecase", usecase, action })`
(`packages/tui/src/jev-control.ts:34`), called from `JevModal`. No other client emits a control
command; there is no generic "extension command" UI affordance.

**Extension → client.** Two channels, both *push-only and non-returning*:
`ctx.appendEvent` (a chrome line) and `ctx.setStatus` (a footer chip). There is **no return value**:
the client reads back through `session.extensionState(extension, key)` (`session.ts:1232`), an opaque
read of the extension's own `state` store — which is exactly what `JevModal` does through
`ExtensionStateReader` (`jev-control.ts:26,38-52`) to render its per-use-case snapshot. A UI
extension protocol that wants request/response already has this shape (command in, state read back),
but it is typed only by convention between one extension and one modal.

## 5. CLI and headless

**Subcommand table.** `packages/cli/src/cli.ts:23-51` (`HELP`) and the dispatch chain
`cli.ts:110-232`: bare `moh`/`tui` → dynamic `import("@moh/tui")` (`cli.ts:55`); then `run`, `serve`,
`mcp`, `init`, `provider`, `manual`, `compact`, `mpm`, `sessions`, `trash`, `usage`, `jev`,
`handoff`, `browser`. Each subcommand is a separate module with its own `*_USAGE` string. A client
that adds a subcommand must edit this chain — there is no command table object.

**Output surfaces.**
- `moh run`: **pure JSONL on stdout**, one line per `AgentEvent`, written by the sink
  (`packages/cli/src/run.ts:388`). Everything else (notes, warnings, the `declared_window`
  correction) goes to **stderr**, one line (`run.ts:383-386`).
- `moh serve`: v1 JSON-RPC-ish protocol, `PROTOCOL_VERSION = 1` (`packages/cli/src/serve.ts:50`);
  inbound `initialize` / `send` / `permission_response` / `interrupt` / `ping`
  (`serve.ts:153-199`); outbound `error`, `permission_request`, `pong`, plus **events verbatim** as
  `{ type: "event", event }` through the same sink (`serve.ts:303`). Documented exit codes: 0 on
  clean stdin EOF, 2 on startup errors (`serve.ts:47-49`).
- `moh compact` / other headless commands: no event stream.

**Headless degradation of the extension seams.** With no permission/consent seam configured,
`#hasConsentSeam` is false (`session.ts:99`, set at `session.ts:402`) and:
- `setStatus` → **one stderr line per new text**, `moh: <extension>: <text>`, repeats silent, clears
  print nothing, and **the exit code is never affected** (`session.ts:1536-1543`);
- `appendEvent` still lands in the log, but nothing renders it in `moh run` (the JSONL carries
  `extension_event` as data for the consumer to interpret) — and a turn that exceeds the per-turn
  event cap flips to a visible cap overlay rather than silently dropping (`extensions.ts:1100-1107`);
- a turn an extension asks to confirm is **refused** headless with one stderr line and the run's
  normal exit code (`run.ts:79-94`, `run.ts:334-337`);
- `moh run` passes only `consent: { onConfirmTurn }` (`run.ts:351`) — no interactive permission seam
  — so un-enabled extensions are skipped with a visible `extension_failed {reason:"consent"}`.

**Exit-code contract.** `moh run`: 0 success; 1 on `result.status === "error"` (with a
`context_length` recovery hint on stderr, `run.ts:456-465`); `130` on a *user* cancellation, `0` when
a confirmation was refused (`run.ts:468-469`); 2 for CLI usage errors (`cli.ts:102-104`, `cli.ts:112`).
Chrome (statuses, notes, declared windows) never moves the code — that is the invariant a UI
extension must respect.

## 6. What a UI extension must not break

- **Clients never talk to providers.** Assembly is one path: `sessionFromConfig`
  (`packages/core/src/session/from-config.ts`, ADR-0005) reads moh.json, merges MCP, resolves the
  provider, wires subagents/memory/stores. Clients inject only consent seams and overrides
  (`run.ts:342-358` for the CLI; the TUI's factory). A UI extension must reach the model through
  `session.send` and nothing else.
- **Nothing imports the TUI (core → client edge is one-way).** The enforcement is *structural*:
  `packages/core/package.json` declares only `@ai-sdk/*`, `ai` and `@moh/extension` — no `@moh/tui`.
  The reverse edge is explicit: the CLI reaches the TUI through the
  `@moh/tui/bundled-extensions` subpath (`run.ts:30`, `serve.ts:26`, `compact.ts:14`) and a lazy
  `import("@moh/tui")` (`cli.ts:55`). **There is no automated architectural check** — no test, no
  lint rule, no CI step greps for a core→tui import (`.github/workflows/ci.yml` runs `bun run
  typecheck`, `bun test packages/core packages/extension`, `packages/cli`, `scripts`, evals, TUI
  unit, PTY). The invariant holds because the package manifest makes it unbuildable, not because
  something asserts it.
- **The PTY suite pins the real screen.** `packages/tui/test/pty/**` (15 files, run as separate bun
  processes by `scripts/test.sh:25`) asserts bytes of a real terminal: layout geometry and a
  mid-session resize (`pty-layout.test.ts`), modal-return anchoring of the input row and bottom bar
  (`modal-return-anchor.pty.test.ts`), `NO_COLOR` painting (`nocolor.pty.test.ts`), home banner /
  compact home (`home-banner.pty.test.ts`, `home-compact.pty.test.ts`), streaming persistence,
  typewriter reveal, natural scrollback, table streaming, image preview, reasoning controls,
  ask-user flows. Practically: any UI-extension feature that paints into the main frame or the
  footer competes for rows these tests measure — footer *chips* are covered by unit tests
  (`extension-status-chip.test.tsx`, `jev-chrome.test.tsx`, `jev-status-chip.test.tsx`), not PTY.

## 7. Is there a generic plugin point in the clients?

**No.** Evidence, in order of strength:

1. No registration API in the TUI: the command list, the overlay union, the block projection and the
   key handlers are all module-local statics or `useInput` closures (§1–§3).
2. No plugin/config key: moh.json has `extensions: string[]` (source *paths*,
   `packages/core/src/config.ts:117`) — that is the *core's* extension loading (ADR-0034/0039 —
   phase hooks), not a UI contribution mechanism. Nothing in the config can add a command, key,
   panel or chip.
3. The extension context is loop-facing only (`extensions.ts:1005-1015`: `appendEvent`, `setStatus`,
   hook registration). A loaded extension cannot even enumerate the client's commands.
4. `CUSTOM_COMMAND_NAMES = new Set([])` (`commands.ts:837`): a populated `custom:` flag is *read* by
   `commandEntries` (`commands.ts:828`) and appears in the popup, but no code path ever adds a
   member — **intent without implementation**, the only such marker in the command surface.
5. The one "third-party UI" in the tree, `JevModal`, is moh's own TUI component for one
   independently-versioned extension (`@moh/jev-guard`), wired by hand through
   `bundledExtensionSources` (`packages/tui/src/bundled-extensions.ts:29-40`). That is the *pattern*
   a protocol would generalize — and it is currently one bespoke modal plus one bespoke control call.

---

## Table — client surface | extensible today? | by whom (mechanism, file:line) | what a UI extension protocol must change

| Surface | Extensible today? | By whom (mechanism) | What a protocol must change |
|---|---|---|---|
| Slash command list | No | moh source only: `BASE_COMMANDS` `commands.ts:732`; gate `activeCommands` `commands.ts:808` | A registration path from a loaded extension into `activeCommands`/`commandEntries`; populate the reserved `custom:` marker (`commands.ts:828,837`) |
| Skill aliases (`/implement`, …) | No (first-party only) | `ALIASES` + `workflowCommands()` `commands.ts:148,757`; `/skill-name` → prompt `commands.ts:769-780` | Either generate aliases from installed skills, or expose the `send(..., {prompt,args})` shape as the extension-facing command result |
| Gated commands (`/wayfinder`) | No | self-gate on `ctx.config.workflow.enabled`, `commands.ts:666-674` | A precondition/visibility contract extensions can declare per contribution |
| Panels / modals | No | closed `Overlay` union `App.tsx:127` + `&&` branches `App.tsx:1640-1870` | An extension-supplied component slot (union member or a registry the render tree maps) — the largest structural gap |
| Chrome lines in the transcript | Yes (text only) | `ctx.appendEvent` → `extension_event` `extensions.ts:1010`, `types.ts:372-380`; rendered `transcript.tsx:974` | Nothing structural; a protocol that wants *interactive* chrome cannot use it |
| New `AgentEvent` types | No (crash) | exhaustive switch throwing at `transcript.tsx:1094-1096` | Refuse inventing events; generalize via `extension_event` payload schemas, or add a client-side registry of projections |
| Footer status | Yes (one text chip) | `ctx.setStatus` `extensions.ts:1117` → `extensionStatuses()` `session.ts:1526` → poll `App.tsx:654-672` → `BottomBar.tsx:435` | Chip-level metadata (colour, icon, click/action); today one string per extension |
| Other footer slots (mpm/memory/jev/warnings) | No | hardcoded props in `BottomBar.tsx:435` | A slot model; each is bespoke moh chrome today |
| Theme tokens | Partially (user only) | user JSON themes `themes.ts:25`, `user-themes.ts:78` | An extension cannot ship or select a theme; protocol would need a theme-provider seam |
| Keybindings | No | inline `useInput` per component: `App.tsx:1208`, `Chat.tsx:1125`, `Home.tsx:244`; docs list `CommandsPanel.tsx:14` | A real binding table (key → action id) that extensions can add rows to — currently the docs list is the only table |
| Control channel | Yes (observe-only seam) | `setExtensionState` `session.ts:1215` → `extensions.ts:1423-1428`; sole emitter `jev-control.ts:34` | Generalize from one bespoke caller to "any command row addressed to an extension"; define reply semantics (today: read-back via `session.ts:1232`) |
| CLI subcommands | No | dispatch chain `cli.ts:110-232`, help `cli.ts:23-51` | A table object (none exists) + a client-side plugin load order; or explicitly out of scope for UI extensions |
| `moh run` JSONL | Yes (as data) | sink `run.ts:388`; `extension_event`/`extension_control` ride it verbatim | Document the event vocabulary an extension may emit so external consumers can render it |
| `moh serve` v1 | Yes (as data) | `PROTOCOL_VERSION = 1` `serve.ts:50`; events verbatim `serve.ts:303` | Version negotiation for extension-carried events; the wire already carries them but no extension-aware message kind exists |
| Headless status/consent | Degraded by design | one stderr line `session.ts:1536-1543`; confirm refused `run.ts:79-94` | Nothing to change: a protocol must keep "chrome never moves the exit code" |
| Exit codes | Fixed contract | `run.ts:456-469` (0/1/130), `cli.ts:102-112` (2), `serve.ts:47-49` (0/2) | Must not be extended by extension-triggered outcomes beyond these |

## Where a UI extension protocol attaches (summary)

1. **Command contributions** — the only place with a pre-built hook is `commandEntries`'
   `custom:` flag (`commands.ts:823-837`); wire a real producer into `activeCommands`
   (`commands.ts:808`) so `/my-cmd` resolves without editing `BASE_COMMANDS`.
2. **Panel contributions** — the hard structural change: open `type Overlay` (`App.tsx:127`) into a
   registry so the render tree (`App.tsx:1640-1870`) can mount extension components, replacing the
   `&&` ladder.
3. **Chrome** — reuse `extension_event` / `setStatus` (`extensions.ts:1010,1117`); keep the
   `transcript.tsx:1094-1096` exhaustive switch closed by never adding event types from an extension.
4. **Control + reply** — generalize `setExtensionState` (`session.ts:1215`) and the
   `extensionState` read-back (`session.ts:1232`) into the documented two-way shape one extension
   (`jev-control.ts:34` → `JevModal`) already uses.
5. **Keys and themes** — both need a table that does not exist (inline `useInput`; theme presets only).

**Invariants that constrain all of the above:** clients never talk to providers (assembly stays
`sessionFromConfig`, `run.ts:342-358`); the core must not import the TUI — enforced by
`packages/core/package.json` deps alone, **not** by any automated check in `ci.yml`; chrome never
changes an exit code (`run.ts:456-469`, `session.ts:1541-1543`); and any painting the protocol does
into the main frame lands inside what the 15 PTY files (`packages/tui/test/pty/**`) measure.

**UNVERIFIED / gaps:** whether `moh compact` mounts bundled extensions (`compact.ts:14` imports the
subpath; the assembly call was not re-read). Everything else above was re-read at HEAD `ff4a5ebd`.
