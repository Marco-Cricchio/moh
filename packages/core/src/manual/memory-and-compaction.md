# Memory & compaction

Two mechanisms keep long-lived context, deliberately separate — no fact
is ever stored in both.

## Memory (across sessions)

Durable facts kept **per project**, at
`~/.moh/projects/<slug>/memory/` (an index plus append-only, dated,
session-signed topic files). After each turn a background **maintenance
subagent** may extract durable facts from the conversation and append
them; a discreet `memory_updated` indicator is the only surface. Memory
is never merged by the core — only appended atomically, and consolidated
(newest-wins with a dated note) by the maintenance subagent itself.

Later sessions load the index plus the relevant topics, so facts about
your project survive restarts without you repeating them.

## Compaction (within a session)

When a session's context grows, compaction rebuilds the past **inside**
the session: an in-log `compaction` marker stores a summary with
pointers, and replay uses the marker instead of replaying everything
covered by it. The log stays integral forever — nothing is ever deleted.

Compaction is automatic: when a turn's measured input crosses 80% of
the active model's context window (or 180k tokens when the window is
unknown), a background summarizer distills the covered past — task
state, decisions, next steps — into a marker, keeping the last 10 turns
verbatim. The next turn starts against the rebuilt context.

You can also force it:

- `/compact` — in-session (TUI): compacts now, same producer.
- `moh compact --session <file>` — from the shell: opens a closed
  session file, compacts it, and closes it again. Compacting never
  consumes the session: it is still suggested and resumable as usual.

## Why two mechanisms

Compaction answers "what happened earlier *in this conversation*";
memory answers "what do we know about *this project*, period". A fact
that matters beyond the session belongs in memory; session detail stays
in the log, compacted when needed.
