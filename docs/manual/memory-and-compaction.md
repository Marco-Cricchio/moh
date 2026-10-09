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

## Retro findings (across sessions)

The same dotdir also accumulates **retro findings**: improvement
candidates extracted automatically when a session closes — a check that
exists in `package.json` but nothing wires it (no pre-commit hook, no CI
job), a bash command re-issued repeatedly within one session, repeated
tool timeouts. Extraction is deterministic (no model call), and findings
land in `~/.moh/projects/<slug>/retro/`, append-only, deduplicated by
their evidence signature.

Accumulation is automatic; **consumption is only at consent** — findings
never reach the system prompt and never edit your steering files:

- `moh retro` reviews them, ordered by confidence, with the context of
  earlier dismissals of the same subject.
- `moh retro --dismiss <signature>` records a durable decision for that
  exact observation. A materially new observation is a new signature and
  can be proposed again.
- `moh retro --apply <signature> --yes` records an approved application.
  Nothing is written automatically; the change itself stays yours.

The only in-session surfaces are a discreet count when findings were
appended, and one session-start line pointing at the report, at most
once every 48 hours. Nothing is ever deleted, and `moh.json`'s `retro`
block (`enabled: false` turns it off) is the only switch.

## Compaction (within a session)

When a session's context grows, compaction rebuilds the past **inside**
the session: an in-log `compaction` marker stores a summary with
pointers, and replay uses the marker instead of replaying everything
covered by it. The log stays integral forever — nothing is ever deleted.

Compaction is automatic: when a turn's measured input crosses 80% of
the active model's context window (or 180k tokens when the window is
unknown), a background summarizer distills the covered past — task
state, decisions, next steps — into a marker, keeping the last 10 turns
verbatim. The next turn starts against the rebuilt context. A turn that
ends with a provider `context_length` error arms the same producer
directly — the provider's "does not fit" outranks the threshold — and
the error names the escape hatches (`/compact`, `/models`).

The summarizer has two strategies, chosen per project in `moh.json`
(`compaction.summarizer`):

- `"llm"` (default) — the compaction subagent writes a dense semantic
  summary of the covered past.
- `"deterministic"` — a rule-built digest of structured facts extracted
  from the covered turns: your requests, the files read and modified,
  per-tool traffic, recent failures, and the tail of the last assistant
  work. No model call is made, and the same covered span produces the
  same bytes on every run, resume and machine — useful for reproducible
  sessions and stable tests. The digest is shallower than an LLM
  summary by design; when it would exceed its size budget, the run
  explicitly degrades to the LLM summarizer and the compaction marker
  records `llm-fallback` — it is never silently truncated. `/compact`
  and `moh compact` use the same strategy as the session.

When a provider refuses a request as too long, its own error message
usually states the window it enforces ("This endpoint's maximum context
length is 131072 tokens"). moh reads that number and uses it: for the
rest of the session, that model reference's window — the trigger above,
the tail policy, the context-fit check and the fallback chain — is the
one the provider itself declared, in place of the shipped catalog
figure. The correction is visible once, as a `declared window` line in
the transcript naming both numbers (headless runs print one line on
stderr), and it never reaches the model: it is chrome. Nothing is
written to any config or catalog — the number lives in the session's own
log, so resuming the session recomputes the same window. A refusal whose
wording moh does not recognize changes nothing and leaves one line in
`~/.moh/context-refusals.log` (bounded, deduplicated, count per wording),
which is how the next wording gets recognized.

You can also force it:

- `/compact` — in-session (TUI): compacts now, same producer.
- `moh compact [--session <file>]` — from the shell: opens a closed
  session file, compacts it, and closes it again. Compacting never
  consumes the session: it is still suggested and resumable as usual.

With Jev active (see the [Jev page](jev.md)), compaction also consults
the **cut guide**: sections of settled work — long tool output,
intermediate attempts — judged safely droppable are left out of the
summary's input, so summaries come out smaller. The guardrails: your
messages and decisions are never offered for the cut, at least 60% of
the judged text always survives, and if Jev is unreachable compaction is
exactly as it is described above. Nothing is deleted from the session
log.

## Why two mechanisms

Compaction answers "what happened earlier *in this conversation*";
memory answers "what do we know about *this project*, period". A fact
that matters beyond the session belongs in memory; session detail stays
in the log, compacted when needed.
