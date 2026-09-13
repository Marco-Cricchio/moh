# ADR-0027: MPM observes external changes via the periodic scan only

Date: 2026-09-13 · Status: Accepted · Supersedes: nothing · Related: #617, #654

## Context

`MpmLifecycle` (#617) shipped with two change-observation channels:

1. a **targeted priority queue** for successful moh edits (`noteEdit`, wired
   via `ToolRunner.onFileMutation`), and
2. a **debounced external-notification seam** (`noteExternalChange`, 1.5s
   debounce) that was, per the #617 spec, meant to receive external file
   changes "from a shared watcher".

The second channel never got a producer: no filesystem watcher or client
hook was ever wired to it (issue #654). Only tests called it. Meanwhile the
lifecycle's periodic scan (every 10s of idle time) already observes every
workspace change — new files, mtime drift with hash confirmation, and
deletes/renames discovered from the other side of the map — and the
first-sight hash check prevents stale adoption at session start.

The dead seam was worse than useless: it made the design look like it had a
sub-10s external channel when it did not, and it carried an option
(`debounceMs`), state (`#dirty`), and tests for a path production never
executed.

## Decision

- `MpmLifecycle.noteExternalChange` and the debounce machinery are **removed**
  (a public `@moh/core` surface change per ADR-0004 — this ADR is that
  explicit decision). `MpmLifecycleOptions.debounceMs` is removed with it.
- The **periodic mtime+hash scan is the sole external-change channel**.
  External edits, `git pull`, branch switches, and generated files are
  noticed on the next idle scan (≤ ~10s after idle; deferred during active
  turns by design, since `maxFilesWhenBusy: 0`).
- moh's **own** edits keep the immediate targeted path (`noteEdit`) — that
  channel is wired, production-critical, and untouched.

## Consequences

- Honest design: one channel per producer — moh edits push, the world is
  polled.
- External-change latency is bounded by the poll interval plus idle
  availability, not by any watcher. This is acceptable: MPM is advisory,
  the orientation re-hashes every cited entry at plan time, and a future
  watcher can be added as a new producer without reopening any seam other
  than a new notification method.
- Tests that exercised the debounced path were rewritten against the scan
  or the edit queue; no coverage was lost.
