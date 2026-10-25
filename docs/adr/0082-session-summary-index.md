# ADR-0082: Persisted session summary index

Status: accepted · Date: 2026-10-25
Related: ADR-0021 (read seam and consumption predicate), principle 2 (the event log is the session), principle 5 (sessions are user data), #1710 / #1713 (bounded streaming listing), #1714

## Context

#1713 made `listSessionSummaries` memory-bounded by streaming each JSONL log,
but a cold listing still `JSON.parse`s every line of every log: CPU time is
O(total bytes of history), not O(rows shown). On a project with thousands of
sessions that is seconds of work on every process start.

## Decision

1. **A disposable per-project cache, never a source of truth.** One file,
   `<project dir>/.summary-index.json`, beside the session logs under
   `~/.moh/projects/<slug>/` (principle 5: never in the project's `.moh/`).
   It holds, per session file, the projection the listing derives from the log:
   `{ size, mtimeMs, title, displayName, pinned, consumed }`. The event log
   stays the session (principle 2); deleting the index loses nothing.
2. **Keyed by file name + size + mtime.** An entry is used only when both
   `size` and `mtimeMs` equal the file's current `stat`. Anything else (new,
   appended-to, replaced) is re-peeked with the existing streaming
   `peekSession`, so the projection — including the ADR-0021 predicate on the
   active path and the corrupt-tail stop — is computed by one implementation.
   Entries for files that no longer exist are dropped on write.
3. **Lazy rebuild only; sessions do not maintain it.** Writers append to the
   log and know nothing about the index. The first listing after a change pays
   for the changed files alone. Rejected: updating the index on every append
   (couples every writer and the fork/compaction paths to a cache, and adds a
   second write to the hot path).
4. **Failure mode: rebuild.** A missing, unparsable, wrong-`version`, or
   wrong-shape index is treated as empty. A failed write is ignored (the
   listing still returns the right rows). The write is atomic (temp file in
   the same directory, `rename`) with mode `0o600`; concurrent moh processes
   race last-writer-wins, which is safe because every entry is validated
   against `stat` on read.
5. **Known limit.** A file rewritten in place with identical size and mtime
   would serve a stale entry. Session logs are append-only, so any real change
   alters the size; the key is the same trade-off `make` accepts.

The in-process memo from #1713 is replaced by this index (one fact, one place).
