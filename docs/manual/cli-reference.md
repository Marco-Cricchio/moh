# CLI reference

Generated from the CLI command definitions — never edit directly
(`bun packages/core/scripts/gen-manual-docs.ts` regenerates it).

## moh — top level

```
moh — headless coding agent

usage: moh [command] [options]

With no command, moh opens the interactive TUI (resume from the home
screen; the mock provider works without credentials).

commands:
  tui      interactive session (same as bare moh)
  run      non-interactive session (see: moh run --help)
  mcp      manage MCP tool servers (see: moh mcp --help)
  init     scaffold agent docs (docs/agents/* + AGENTS.md)
  provider manage provider endpoints and auth (see: moh provider --help)
  manual   read the user manual (see: moh manual --help)
  compact  compact a session's context in place (see: moh compact --help)
  mpm      project map diagnostics (see: moh mpm --help)
  sessions session management (rename, delete, tree, analyze; see: moh sessions --help)
  trash    the session trash (list, restore; see: moh trash --help)
  usage    usage reports: models, tools, routes (see: moh usage --help)
  jev      TypeSafe/Jev configuration and per-use-case flags (see: moh jev --help)
  handoff  publish a session handoff (see: moh handoff --help)
  browser  browser tool status and setup (see: moh browser --help)

options:
  --yolo     unrestricted tools: no permission prompts, no filesystem
             containment (launch default; shift+tab leaves it in-session; MCP consent still applies)
  --version  print version and exit
  --help     show this help
```

## moh run

```
usage: moh run [options] [prompt...]

Runs one non-interactive turn. Events stream to stdout as JSON lines and
are persisted to the session JSONL log (~/.moh/projects/<slug>/<id>.jsonl).

options:
  -p, --prompt <text>        the prompt (alternative to the positional form)
  --allow <rule>             grant a permission rule (repeatable)
  --deny <rule>              deny a permission rule (repeatable)
  --session <file>           resume an existing session JSONL (append)
  --resume [query]           resume a session of this project by discovery (#401):
                            a query filters and the best match is opened; with no
                            query the sessions are listed (newest first) to pick
                            from (a query may be a session id or title text)
  --fork                     with --session: copy history into a new session file
  --fork-scope <s>           fork scope (#768): "tree" (default, all branches)
                            or "branch" — only the active root→head path
  --provider <ref>           "mock", a custom id, or endpoint/model-id (moh.json)
  --max-iterations <n>       per-turn iteration cap override (#498): 50|100|200|500
                            or "unlimited" (any integer 1-500 is also accepted);
                            wins over moh.json maxIterations for this run
  --cassette <file>          run the mock provider from a JSON cassette (e2e/evals)
  --auto-accept              auto-accept every permission prompt
  --yolo                     no permission prompts, unrestricted filesystem (launch default; shift+tab rotates modes in-session)
  --cwd <dir>                project root (default: process.cwd())

rules: "bash", "bash:git status", "write:src/**", "edit:docs/**" — same
grammar as moh.json permissions.overrides; CLI flags win on top of them.

notes:
  - exit code 0 means the turn completed (denied tools are structured
    denial events the model sees, not failures); 1 = turn error, 130 =
    cancelled, 2 = usage error.
  - resuming with --session does not carry --allow/--deny rules forward:
    re-pass them on every run (runtime "always" rules from the log are
    restored automatically).
  - a turn an extension asks to confirm is refused here (one stderr line,
    exit 0): headless cannot ask, so it never sends what it cannot show.
  - a project root under /mnt (a Windows drive in WSL) prints one note on
    stderr: file I/O there is dramatically slower. Environment information,
    never a turn error; stdout stays pure JSONL.
  - an enabled browser tool whose toolchain is missing prints one note on
    stderr naming the missing component and the setup command (moh browser
    install): the optional tool is simply not registered, never a turn
    error; stdout stays pure JSONL.
```

## moh serve

```
usage: moh serve [options]

RPC mode: drive one session over stdin/stdout as LF-delimited JSON
lines (protocol v1, see docs/serve-protocol.md). Events stream to
stdout interleaved with protocol messages; stderr stays for human
warnings. The session persists to the same JSONL log as moh run, so a
session can move between moh run --session, moh serve, and TUI resume.

options:
  --provider <ref>           "mock", a custom id, or endpoint/model-id (moh.json)
  --session <file>           resume an existing session JSONL (append)
  --allow <rule>             grant a permission rule (repeatable)
  --deny <rule>              deny a permission rule (repeatable)
  --auto-accept              auto-accept every permission prompt
  --yolo                     no permission prompts, unrestricted filesystem
  --cwd <dir>                project root (default: process.cwd())

notes:
  - initialize (the first client message) may override cwd, provider
    and permission rules per connection; launch flags are the defaults.
  - exit code: 0 on clean stdin EOF, 2 on startup errors.
```

## moh mcp

```
usage: moh mcp <command> [options]

commands:
  add <name> [--user] (-- <command> [args...] | --url <url>) [--env K=V]... [--header 'K: V']...
          declare an MCP server (stdio via \`--\`, or HTTP streamable via --url)
  remove <name> [--user]
          remove a server (project first, then user)
  list    show declared servers from both scopes
  restart <name> [--cwd <dir>]
          manual restart of a crashed server. A separate process cannot
          reach a live session's servers, so this verifies the server
          starts again (handshake + tool listing); reopen the session (or
          restart it via its client) to pick the server back up.

scopes: project (moh.json, asks consent on first use) vs user
(~/.moh/config, trusted). Use --user to target the user config.
```

## moh provider

```
usage: moh provider <command>

commands:
  add              guided provider onboarding (asks api-key or subscription
                   auth first; subscription runs the provider's OAuth flow)
  login <name>     re-authenticate a subscription endpoint
  logout <name>    drop a subscription endpoint's stored tokens
  status           per-endpoint auth kind, token expiry, plan usage
  fallback <name> [model]
                   set the endpoint's preferred model — the model it serves
                   with when it is an automatic fallback stop (ADR-0012);
                   omit the model (or pass --clear) to drop it from the chain
                   --exclude/--include keep the whole provider out of the
                   chain (or back in), independent of its model

tokens live in ~/.moh/config (never in moh.json); \`logout\` and a
successful \`login\` are the only token deleters.
```

## moh manual

```
usage: moh manual [page]

Prints a manual page, or the index with no argument. Page ids match the
TUI manual (ctrl+h / /help) and docs/manual/.
```

## moh update

```
usage: moh update [options]

Update the moh binary in place to the latest stable GitHub Release:
download the platform asset, verify its sha256 against the release's
checksums.txt, then atomically replace the running executable.

Downgrades from a non-stable build to the latest stable ask for
confirmation; pass --yes to skip (or to run non-interactively).

options:
  --yes   assume "yes" at the downgrade confirmation
  --help  show this help
```

## moh handoff

```
usage: moh handoff [--notify-ticket] [--cwd <dir>]
       moh handoff export <file> [--cwd <dir>]
       moh handoff import <file> [--cwd <dir>]
       moh handoff pull <gist-url> [--cwd <dir>]

With no subcommand: publishes the local session handoff when
handoff.transport is "gist".

export/import (#440) are the manual file fallback — for machines with
no gh, offline transfers, or removable media:
  export <file>    write the local handoff artifact (with the same
                   read-only Wayfinder enrichment as a publish) to <file>
  import <file>    validate a received export and register it for this
                   project; the newest of gist/import/local is then
                   offered at the next startup
  pull <url>       explicit fallback for story 17: fetch the handoff
                   gist at <url> (bare gist id works too) when the
                   deterministic-tag discovery misses, validate it, and
                   register it — the same author check as import applies

options:
  --notify-ticket  after a successful publish, comment only Wayfinder tickets
                   successfully claimed in this session (never implied)
  --cwd <dir>      project root (default: process.cwd())
```

## moh compact

```
usage: moh compact [--session <file>] [--cwd <dir>]

Compacts a session's context in place: appends a compaction marker
(a summary of the older turns plus a pointer), keeping the last 10
turns verbatim. The log is append-only — nothing is ever deleted.

  --session <file>   the session JSONL to compact
                     (default: the project's most recent session)
  --cwd <dir>        project root the session belongs to
                     (default: process.cwd())

Compacting never consumes a session: it can still be suggested and
resumed as usual afterwards.
```

## moh mpm

```
usage: moh mpm [--cwd <dir>] [--json]

Local diagnostics for the Moh Project Map: what is mapped, how fresh it
is, what work is pending, and which budgets and exclusions apply.

  --cwd <dir>   project root to report on (default: process.cwd())
  --json        machine-readable output (the full diagnostics object)

Diagnostics are metadata only: paths, counts, and timings — never source
content. When MPM is disabled (MPM is opt-in: off unless the user default
or an explicit project override turns it on), the report says which side
disabled it.
```

## moh sessions

```
usage: moh sessions rename <file|id> <name> [--cwd <dir>]
       moh sessions delete <file|id> [--yes] [--cwd <dir>]
       moh sessions tree <file|id> [--cwd <dir>]
       moh sessions switch <file|id> <node|bookmark-name> [--cwd <dir>]
       moh sessions bookmark <file|id> <node> [name] [--cwd <dir>]
       moh sessions analyze <file|id> [--json] [--cwd <dir>]

Renames a session: the display name shows in the TUI home picker and
overrides the derived first-message title. An empty name resets to the
derived title. Display names never touch file names or slugs.

  file|id   the session JSONL path, or a session id from \`moh run --list\`
  name      the new display name (empty string resets)
  --cwd     project root the session belongs to (default: process.cwd())

delete moves the session's JSONL file into the trash
(~/.moh/trash/projects/<slug>/ — restorable via \`moh trash restore\
```

## moh usage

```
usage: moh usage [tools|routes|export] [--format csv|jsonl] [--out <path>] [--project <slug>] [--days <N>] [--json] [--cwd <dir>]

Telemetry sub-reports over the project's local sessions (default: per-model
usage). Metadata only; failed model calls are excluded (they consumed
nothing measurable). Estimated USD is release-pinned approximate pricing;
models without a price record remain tokens-only.

  (default)   per-model usage: model calls, input and output tokens
  tools       per-tool calls, ok/fail rate, timeouts, average call→result
              duration where derivable; failed results with a structured
              errorKind are broken down per reason
  routes      fallback activations (from→to, reason), route_serving
              switches, and turn errors grouped by ProviderError kind

  export      redacted metadata-only export (CSV or JSONL) of the aggregate
              telemetry — per-model usage, per-tool stats, per-session
              rollups. No message content, tool outputs, or reasoning is
              ever included: everything is redacted by construction.
  --format    export format: csv (long "section,entity,metric,value" rows)
              or jsonl (one record per line). Required with export.
  --out       write the export to a path (default: stdout)
  --project   another project's slug (default: the current project)
  --days      only sessions modified within the last N days
  --json      machine-readable JSON
  --cwd       project root (default: process.cwd())
```

## moh jev

```
usage: moh jev status [--json]
       moh jev <use-case> on|off

The TypeSafe/Jev configuration: a stored API key (which is what activates
the bundled Jev extension — there is no separate toggle) and the per-use-case
opt-ins.

  status        the current configuration (see the flags below)
  <use-case> on|off
                write one use-case flag to ~/.moh/config — persistent:
                what a new session starts in

  --json        one-line machine-readable JSON with status: active, keyHint
                (absent when inactive), timeoutMs, routing, injection, lint,
                classification, rerank, skills

Use cases: routing, injection, classification, lint, rerank, skills.
Session-only (no flag to write): guardrail — it has no configuration switch
at all (a stored key is what turns it on), so it can only be switched off for
one session, from the TUI's /jev modal.

Switching a use case inside a running session is /jev's job too: a session
command is session-warm and this command is persistent — that is the whole
difference. Nothing here makes a call to TypeSafe: the key is validated when
it is saved, from the TUI Settings panel (Jev / TypeSafe), and is never
printed — only its masked tail. The status of an active or inactive Jev
exits 0; a malformed "typesafe" section and any usage error exit 2.
```

## moh browser

```
usage: moh browser [status|install] [options]

The native browser tool (#774, ADR-0029) is opt-in and needs an optional
toolchain: playwright-core plus a Chromium build. moh owns it — setup runs
on the Bun runtime embedded in the binary (no npm, no system Bun, no
sudo), installs the package into ~/.moh/browser-toolchain and leaves
Chromium in Playwright's own per-user cache. A playwright-core installed
in the project's node_modules is used as-is and takes precedence.

  status    what is available and what is missing (default). Exit code 0
            when a headless launch would work, 1 otherwise
  install   install or refresh playwright-core and the Chromium headless
            shell (~200 MB — the piece a headless launch needs)

options:
  --with-chromium  with install: also download the full Chromium build
                   (~500 MB, needed by browser.headless: false)
  --with-deps      with install: also run Playwright's system dependency
                   installer; it may ask for your system administrator
                   password
  --cwd <dir>      project root (default: process.cwd())
  --help           show this help
```
