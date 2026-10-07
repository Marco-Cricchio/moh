# Extensions

An extension is a module that observes and constrains a running session:
it can veto a tool call, ask you before one runs, inspect a tool result,
shape a compaction, add a note to the prompt — or, with a per-section
capability grant, replace one of the six data prompt sections entirely
(the core writes a provenance line into whatever it replaced, and one
`prompt_override` log line per composition change so you can always see
what was in force). It can never grant a permission — everything an
extension does is additive and can only make moh more careful, never less.

This page is the *user's* side of that contract: where extensions come
from, what you are asked before one runs, and what happens when one breaks.
If you want to *write* one, read the chapter for extension writers in the
repository (`docs/extending/extensions.md`).

## Two sources

- **`~/.moh/extensions/`** — your own extension folder. Every `.ts`,
  `.mts`, `.js` or `.mjs` file directly inside it is loaded, sorted by file
  name. Create the folder and drop a file in.
- **`moh.json` `"extensions": ["./extensions/team-rules.ts"]`** — the
  project declares extensions for everyone who works on it. Paths are
  relative to the project root (absolute paths work too).

Order matters: the files in `~/.moh/extensions/` load first (sorted), then
the project's declarations in the order it lists them. When two extensions
disagree about a tool call, the first one wins.

## The first load asks you

An extension is arbitrary code running inside the moh process, so moh never
enables one silently. A file that has not been allowed yet raises a prompt
that names the file, a SHA-256 of its exact bytes, the capabilities its
`moh.extension.json` manifest declares — each rendered as the concrete
effect a yes grants (a `spawn-subagent` grant, for instance, reads as
"may create up to 10 concurrent child sessions and steer or stop them") —
the manifest's own `reasoning` statement when it declares one, and says
plainly that there is no sandbox. Answer `y` to enable it, `n` to leave it
alone.

The question comes **before the file is loaded**, because loading a module
runs it: a file you decline — or that nobody could ask you about — never
executes a single line. A file with no (or a malformed) manifest is
refused before the question even exists (ADR-0061). That is also why the
prompt shows no name or
version of its own: those are the module's claims, and at the moment it is
asked about the file has not run yet, so it has made none (they are not the
trusted part anyway — your answer is bound to the bytes). Once an allowed
file loads, its name and version appear in the session log
(`extension_loaded`); on an *edited* file the re-ask can name it, because
the previous instance already knew.

Your answer is remembered in `~/.moh/extensions.json`, tied to the file's
path, its exact contents **and the manifest's**:

- the same file and manifest, unchanged, load without asking ever again;
- edit the file or its manifest and the next session asks again — the code
  you approved is not the code that is there now; a widening manifest edit
  shows the capability diff in the question;
- delete the folder entry (or the `moh.json` declaration) and the extension
  simply stops being loaded; the remembered answer stays but does nothing.

A project cannot enable anything by itself: a `moh.json` declaration is a
proposal, and a clone you never answered a prompt for loads nothing.

## When there is nobody to ask

`moh run`, `moh serve` and `moh compact` cannot prompt. An extension that
was never enabled is skipped there too — and "skipped" here means **never
loaded**: the file is not imported, so not one line of it runs. The same
holds for a file with no (or a malformed) `moh.extension.json` — the
manifest is what the consent question reads, so without one nothing is
asked and nothing runs (ADR-0061). The session
records a visible `extension_failed` with reason `consent`, prints one line
on stderr, and carries on. The exit code is not affected — a skipped
extension is not an error.

## Failure modes

Every failure is visible and none of them aborts the session:

| Situation | What you see |
| --- | --- |
| the file has no — or a malformed — `moh.extension.json` beside it | `extension_failed` with reason `manifest`; nothing is asked and the file is never imported |
| the code uses a capability its manifest does not declare | `extension_failed` with reason `capability_undeclared`, naming the offending slot |
| the file has a syntax error or a missing import | `extension_failed` with reason `load_failed` |
| the module's default export is not a valid extension | `extension_failed` with reason `invalid` |
| its `apiVersion` major does not match this moh | `extension_failed` with reason `api_version_mismatch` |
| it declares npm `dependencies` | `extension_failed` with reason `deps_unauthorized` — no host installs dependencies yet |
| it throws during `setup()` | `extension_failed` with reason `setup_failed` |
| you declined the prompt | `extension_failed` with reason `consent` |
| a hook throws at runtime | `extension_failed` with reason `hook`, and the turn proceeds |
| it records more than 50 events in one turn | one `extension_failed` with reason `event_cap` naming the session it belongs to, and the rest of that turn's records are dropped — the budget is per session, so a subagent's records never spend its parent's turn |

The failures land in the session log, so a resumed session still explains
what was missing. An enabled extension that is gone from disk by the time
you resume is reported the same way (`missing_on_resume`), never silently
dropped.

## Hot-reload

Files loaded by a client are watched while the session runs. Edit one and
moh re-imports it and runs its `setup()` again, with the state it had kept
(`ctx.state` survives the swap). A reload that fails — a syntax error, a
changed `apiVersion`, a refused consent because the bytes changed — leaves
the previous instance running and records the failure.

## What an extension may contribute

An extension whose grant covers `contribute-commands` (named explicitly
in its consent question) registers slash commands that run like native
ones. Precedence is native commands > skills > extension commands: a
colliding name is refused loudly, and `/extensions` lists every extension's
commands plus each refused registration with its reason. `/extensions`
opens the read-only extension-state screen: per enabled extension its
version, source path (or "bundled"), declared capabilities, registered
commands and the prompt sections it currently owns (ADR-0054); then the
last failure with its reason, every refused registration, and the ignored
duplicate copies (the project copy wins, the loser is named). The same
state is derivable from the session's event log alone, so a headless
reader folds it without a live session. The command never writes
configuration. The same command
runs headless: `moh run "/deploy-status --env prod"` prints one
`extension_command_result` JSON line with the command's text output — the
same text the TUI shows, never a second behavior.

An extension whose grant covers `contribute-panels` contributes one panel
to the extensions rail (#1132, ADR-0062): a zone that opens by itself
when a team is composed and is otherwise opened and closed by the user
(from `/extensions`, `r`), collapsing to the footer on narrow terminals. At most 4 panels
are visible across all extensions — a fifth extension asking for a panel
is refused visibly at load (`panel slot exhausted (4/4) — disable a panel
in /extensions`), and there is no automatic eviction: collapsing and
reopening a panel is manual, from `/extensions`. With the rail focused
(`ctrl+p`) the client hands the panel its keys (apiVersion 1.17): the
team panel, for one, uses `n`/`p` to move between members and `enter`
to open and close the member detail inside the panel. `j`/`k` and the
arrows scroll the panel's window, unless the panel consumes them first
(apiVersion 1.18) — in the team detail view every letter composes the
steering draft, and `enter` sends it to the member as its next turn;
in the roster, `x` stops everything the team spawned (one
`orchestration_stopped` record; lanes and worktrees survive).
`esc` always leaves the rail. An
extension whose grant
covers `contribute-overlays` contributes a full-screen overlay, opened by
the extension's own command and closed with `Esc`. A headless client has
no rail and no overlays: panels and overlays contribute nothing there —
visible absence in `/extensions`, never a simulated textual rendering.
Anything a panel callback does that the permission gate covers flows
through the same gate as any other action — the click invokes, it never
grants.

An extension whose grant covers `spawn-subagent` (#998, ADR-0053/0055)
delegates: `ctx.spawnSubagent(spec)` creates a subagent child within its
envelope — ten children per extension per session, each within the
session's iteration ceiling — and every request outside the envelope is
refused loudly (`extension_failed`), never silently narrowed. No
grandchildren, and the owner's one stop aborts everything the extension
started. `ctx.subagentActivity(callId)` reads the bounded child-tail
activity of a child the extension spawned; a session it did not spawn
does not exist for it. `ctx.steerSubagent(callId, message)` (#1222)
writes a follow-up message into a child it spawned — the member's next
turn, context and route kept; the same ownership rule applies, so
members can never address each other, and the write is recorded as
`subagent_steer` chrome in the parent's log. The spawn spec also takes
`pathScopes` (#1224) — project-root globs that restrict the child's
writes through the permission spine (a logged `permission_denied`, even
in yolo; an empty list is fully read-only) — and `model`, a route pin
for the child's own provider (`endpoint/model-id`, ADR-0050). The
`extension_loaded`
event carries the granted
capabilities — the startup announcement of what each enabled extension
holds.

## There is no sandbox

An extension runs with the same privileges as moh itself. It can read your
config in `~/.moh/`, your credentials and auth tokens, your project, and
the network. Consent plus the veto-only contract is the whole trust model —
there is no capability boundary behind it. Read a file before you answer
the prompt, and treat an extension like any other program you run on your
machine.
