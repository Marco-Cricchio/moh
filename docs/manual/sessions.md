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
derived title. In an open session, `ctrl+r` opens a rename editor (empty resets,
esc cancels); `/rename <name>` sets the same display name. From the CLI:
`moh sessions rename <file|id> <name>` (an empty name resets). The name is
a chrome event in the log — resume,
fork (it is inherited) and compaction carry it for free — and it never
touches file names or slugs.

## The session tree (/tree)

A session is a **tree**: rewinding (switching the head to an earlier
turn) and divergences grow branches, and the `/tree` panel shows the
full topology — one row per turn, depth-indented, `●` on the active
path, `○` off it, `◆ name` bookmarked, `← head` on the current head,
`⚠` on the branch created by another machine (external growth).

Keys: `↑/↓` (or `j/k`) move with internal scrolling when the tree is
taller than the panel, `⏎` **switch here** (the head moves immediately —
while a turn is in flight the switch still lands in the log and takes
effect next turn), `r` **branch from here** (switch, close the panel,
and a sticky banner reminds you that your next message starts a new
branch — the banner dismisses when you send it), `b` toggles a bookmark,
`B` names one (empty = clear), `f` cycles the filters
`all → active+bookmarked → abandoned only`, esc closes. `/tree` needs an
open session; the CLI equivalents (`moh sessions tree|switch|bookmark`)
are planned separately (#582).

Switching never **consumes** the session: the pertinent-session
suggestion is unaffected. When the session file grew on another machine
(#400), the growth warning's primary chip becomes **keep my branch**
(`ctrl+g`): it moves the head back to your local tip and clears the
warning — forking (`/fork`) stays the secondary recovery path.

## Bookmarks

A **bookmark** names a node of the session tree (a turn or an earlier
event) for humans: it is what makes the `/tree` panel's branch filters
useful and marks a node you want to find again (`◆ name` in the tree
view). Bookmarks ride the same seam as the display name: appending a
`tree_bookmarked` event to the log — append-only, the **last** bookmark
for a node wins, and a bookmark with an **empty name clears** the node's
bookmark. In the `/tree` panel: `b` toggles a bookmark on the selected
row, `B` sets a name. From the CLI (when the `moh sessions bookmark`
command lands, #582): `moh sessions bookmark <file|id> <node> [name]`,
where an empty (or blank) name clears and `node` accepts an event id or `line:N`.
Bookmarking never changes what the model sees — it is chrome in the log,
carried by resume and fork like any other event.

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
Inspect and recover with `moh trash list` (id, project, age, days left)
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

Each published handoff carries the canonical HTTPS clone URL of the
project's Git `origin`, when one is available. A **truly cold** directory
(no Git checkout in it or a parent, and no local sessions for the project)
can offer published handoffs automatically at startup when
`handoff.transport` is set to `"gist"`. Select one, choose where to clone
it, and moh clones the repository, pulls the handoff, and opens the normal
seeded session. The Home picker also offers `o` — **resume
from another machine** — as an explicit path at any time, including for an
already-cloned repository with no local sessions.

Older handoffs without a repository URL cannot be cloned automatically.
For one of these, choose the path of an existing checkout; moh pulls the
handoff into that project and opens the seeded session. If discovery cannot
reach GitHub, finds no authenticated `gh` user, or finds no valid handoffs,
it simply has nothing to offer.

If a remote handoff is strictly newer than the one you are publishing,
moh protects it: `moh handoff` shows an `y/N` overwrite prompt. Automatic
publish on exit declines instead and warns you to run `moh handoff`
explicitly. Equal timestamps publish normally. This guard never changes
local sessions.
