# Sessions

Every conversation is a **session**: one append-only JSONL event log at
`~/.moh/projects/<project-slug>/<id>.jsonl`. Sessions are your data;
they never live inside the project directory. The log *is* the session —
streaming, persistence and replay all read the same sequence of events.

## New

The home screen is the session list. Typing with no filter matches and
pressing enter starts a new session with your text as the first prompt.
`n` starts an empty one. From the CLI, `moh run "prompt"` runs a single
non-interactive session.

## Resume

Reopening a past session **appends to the same file**: history, memory
and permission decisions carry over. The home list shows your recent
sessions — enter reopens one. On the CLI, `moh run --resume` discovers a
session of the current project by query (an id or title text) or lists
them newest-first; `moh run --session <file>` targets an exact log.

## Fork

Forking copies history into a **new** session file and continues there —
use it to branch a "what if" off a real session without touching the
original. On the CLI: `moh run --session <file> --fork`.

## Rename

A session can carry a **display name**: a permanent override of the
derived title (the first message), shown in the home picker and used by
the search — which matches both the display name and the original
derived title. Rename from the home screen with `r` or → on a selected
session row (the pertinent banner included): edit the prefilled name,
enter confirms, esc cancels, enter on an empty name resets to the
derived title. From the CLI: `moh sessions rename <file|id> <name>`
(an empty name resets). The name is a chrome event in the log — resume,
fork (it is inherited) and compaction carry it for free — and it never
touches file names or slugs.

## Delete and the trash

Deleting a session (home screen: `d` on a selected session row, `y`
confirms the `y/N` prompt; CLI: `moh sessions delete <file|id> [--yes]`)
moves its JSONL file into the **session trash** at
`~/.moh/trash/projects/<slug>/` — the same structure as the live project
directory, so ids never collide. Only the file moves: forks keep their
own copies of the history and project memory is untouched, and deleting
the currently open session is refused. Trashed sessions rest for a
retention window (30 days by default, configurable via
`sessionTrash.retentionDays` in `~/.moh/config`) before a lazy prune
removes them — checked at delete and listing time, no background job.
Inspect and recover with `moh trash list` (id, title, age, days left)
and `moh trash restore <file|id>`, which moves the file back into its
project directory (refusing a collision with a live session — nothing
is ever silently overwritten). A deleted session simply stops appearing
in the home picker and listings; if it was the pertinent suggestion, the
banner vanishes on refresh.

## Handoff between machines

moh can carry a session between your machines with a **handoff**: a
structured synthesis plus a filtered event-log extract published as a
secret gist (requires `gh`). It is a *serial* handoff — close the
session on one machine, then resume on the other; simultaneous use of
the same session file on two machines is unsupported (a growth warning
fires if it happens anyway; forking is the recovery). Configure it under
`handoff.transport` in moh.json; `moh handoff export/import` is the
manual file fallback when `gh` is unavailable. With a single machine
nothing is ever published — the feature is opt-in per project.
