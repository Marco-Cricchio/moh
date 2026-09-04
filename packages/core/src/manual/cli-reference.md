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
  sessions session management (rename, delete; see: moh sessions --help)
  trash    the session trash (list, restore; see: moh trash --help)
  handoff  publish a session handoff (see: moh handoff --help)

options:
  --yolo     unrestricted tools: no permission prompts, no filesystem
             containment (launch-only; MCP consent still applies)
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
  --provider <ref>           "mock", a custom id, or endpoint/model-id (moh.json)
  --cassette <file>          run the mock provider from a JSON cassette (e2e/evals)
  --auto-accept              auto-accept every permission prompt
  --yolo                     no permission prompts, unrestricted filesystem (launch-only)
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

## moh sessions rename

```
usage: moh sessions rename <file|id> <name> [--cwd <dir>]
       moh sessions delete <file|id> [--yes] [--cwd <dir>]

Renames a session: the display name shows in the TUI home picker and
overrides the derived first-message title. An empty name resets to the
derived title. Display names never touch file names or slugs.

  file|id   the session JSONL path, or a session id from \`moh run --list\`
  name      the new display name (empty string resets)
  --cwd     project root the session belongs to (default: process.cwd())

delete moves the session's JSONL file into the trash
(~/.moh/trash/projects/<slug>/ — restorable via \`moh trash restore\
```
