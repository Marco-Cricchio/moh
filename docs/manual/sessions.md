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
