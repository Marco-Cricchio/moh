# Extensions

An extension is a module that observes and constrains a running session:
it can veto a tool call, ask you before one runs, inspect a tool result,
shape a compaction, add a note to the prompt. It can never grant a
permission — everything an extension does is additive and can only make moh
more careful, never less.

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
that names the file and a SHA-256 of its exact bytes, and says plainly that
there is no sandbox. Answer `y` to enable it, `n` to leave it alone.

The question comes **before the file is loaded**, because loading a module
runs it: a file you decline — or that nobody could ask you about — never
executes a single line. That is also why the prompt shows no name or
version of its own: those are the module's claims, and at the moment it is
asked about the file has not run yet, so it has made none (they are not the
trusted part anyway — your answer is bound to the bytes). Once an allowed
file loads, its name and version appear in the session log
(`extension_loaded`); on an *edited* file the re-ask can name it, because
the previous instance already knew.

Your answer is remembered in `~/.moh/extensions.json`, tied to the file's
path **and its exact contents**:

- the same file, unchanged, loads without asking ever again;
- edit the file and the next session asks again — the code you approved is
  not the code that is there now;
- delete the folder entry (or the `moh.json` declaration) and the extension
  simply stops being loaded; the remembered answer stays but does nothing.

A project cannot enable anything by itself: a `moh.json` declaration is a
proposal, and a clone you never answered a prompt for loads nothing.

## When there is nobody to ask

`moh run`, `moh serve` and `moh compact` cannot prompt. An extension that
was never enabled is skipped there too — and "skipped" here means **never
loaded**: the file is not imported, so not one line of it runs. The session
records a visible `extension_failed` with reason `consent`, prints one line
on stderr, and carries on. The exit code is not affected — a skipped
extension is not an error.

## Failure modes

Every failure is visible and none of them aborts the session:

| Situation | What you see |
| --- | --- |
| the file has a syntax error or a missing import | `extension_failed` with reason `load_failed` |
| the module's default export is not a valid extension | `extension_failed` with reason `invalid` |
| its `apiVersion` major does not match this moh | `extension_failed` with reason `api_version_mismatch` |
| it declares npm `dependencies` | `extension_failed` with reason `deps_unauthorized` — no host installs dependencies yet |
| it throws during `setup()` | `extension_failed` with reason `setup_failed` |
| you declined the prompt | `extension_failed` with reason `consent` |
| a hook throws at runtime | `extension_failed` with reason `hook`, and the turn proceeds |

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

## There is no sandbox

An extension runs with the same privileges as moh itself. It can read your
config in `~/.moh/`, your credentials and auth tokens, your project, and
the network. Consent plus the veto-only contract is the whole trust model —
there is no capability boundary behind it. Read a file before you answer
the prompt, and treat an extension like any other program you run on your
machine.
