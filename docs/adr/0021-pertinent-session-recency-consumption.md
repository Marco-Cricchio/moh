# ADR-0021: pertinent session via recency + session_resumed

Status: accepted · Date: 2026-09-03 · Parent: issue #464 (wayfinder #461, continuity)

## Context

The TUI resume picker (`packages/tui/src/Home.tsx`, via `listSessionSummaries`,
#401) lists prior sessions newest-first by file mtime, each with only its id, mtime,
and a title (first `user_message`). The owner wants the picker to suggest the
*pertinent* session at startup — and decided (grilling #464) that pertinence lives
in the picker only: no proactive in-session suggestions, no CLI-only variant.

Two facts constrained the design:

- **No event carries a timestamp**, and a resume leaves **no trace at all** in the
  log (nor outside it). "Already consumed" was therefore unobservable.
- The richer alternative — scoring affinity between the session's past `tool_call`
  file paths and the current working tree — would require parsing untyped per-tool
  `args` and adding an explainable scoring surface, for marginal gain over recency.

## Decision

1. **Pertinence = recency + consumption, nothing else.** The pertinent session is
   the most recent (mtime) session **not yet consumed**. No content/file-affinity
   scoring: one heuristic, zero extra parsing, easy to explain.
2. **`session_resumed` chrome event (public surface change, ADR-0004).** A new
   chrome event `{ type: "session_resumed" }`, appended by the **core** on the
   resume path (open of a session with pre-existing events) — in the TUI and in
   `moh run --resume` alike, since both ride the same seam (#401). Appended
   **at resume-open**, before any turn: a resumed-then-closed-without-work session
   counts as seen. Forks are born consumed: the store-level fork appends a
   `session_resumed` to the new file, so a fork never appears in the banner.
3. **Consumption is re-openable.** A session is consumed iff a `session_resumed`
   exists **after its last turn** (index comparison in the append-only log — no
   per-event timestamps added). A session resumed and then worked on again becomes
   suggestible again.
4. **Read seam.** `listSessionSummaries` (the single existing seam, #401) gains a
   `consumed: boolean` field; its line parse drops the early-exit at the first
   `user_message` so it also records the last `session_resumed` index. No new
   core function, no manifest, no per-project index.
5. **UI.** The picker renders the pertinent session (first unconsumed row, if any)
   as a **pre-selected banner row** above the list: relative time + title
   ("Ieri 18:40 · Fix fork su sessioni vuote"). Enter opens it; arrow-down skips it.
   No banner when no unconsumed session exists (zero noise). Unreadable/empty
   sessions are never suggested (existing "(unreadable session)" fallback rows
   stay out of the banner).
6. **Headless unchanged.** `moh run --resume` keeps its current listing and
   last-session resume behavior; the CLI consumes the event only implicitly
   (it appends it), projecting no suggestion.

## Consequences

- One chrome event is added to the append-only log per resume — permanent, so this
  is the hard-to-reverse part; it is the single source of consumption for any
  future consumer (replay shows it as chrome, like `session_file_growth`).
- The picker's read cost grows from early-exit to full-line parse per session file
  (still no replay, no JSON-tree walk of `args`).
- Rejected: file-affinity scoring (untyped args, explainability cost), proactive
  in-session suggestions, CLI suggestion variants, a persisted
  "consumed" store outside the log (sessions are user data; picker stays read-only).
