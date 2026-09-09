# ADR-0023: session tree — in-place branching instead of fork

Status: accepted · Date: 2026-09-09 · Parent: issue #571 (wayfinder #565, vision note 33)

## Context

A moh session file is a linear, append-only JSONL of `AgentEvent`s. When the user
wants to go back and try a different path ("torna a N messaggi fa"), today the
only mechanism is **fork**: a byte-for-byte copy of the file into a new session
(ADR-0020 made fork an explicit user action). Prior art (#567: Claude Code
`/rewind`, Codex Esc-Esc, Cline/Gemini restore, Claude Code `/branch`, codex
fork) shows two families — in-file rewind with implicit head, and copy-out
branching — and **no surveyed tool implements an in-file tree**. moh's answer is
the in-file tree: one file holds every branch, head is a chrome event, and the
model context sees only the active root→head path.

The decision was charted in grilling across four tickets, each consolidated in a
spec:

- **format + head/divergence** — `docs/spec/session-tree-format.md` (#566, #569)
- **core semantics** — `docs/spec/session-tree-core.md` (#568)
- **surfaces** — `docs/spec/session-tree-surfaces.md` (#570)

## Decision

**Go.** The session tree is the ratified direction: in-place branching inside
one session file, replacing fork as the primary "go back" mechanism. Fork
remains, secondary (see below). The decisions ratified here are summarized from
the specs, which remain the normative source of record.

### Format (#566)

1. **Optional fields, no envelope.** `AgentEvent` gains optional `id` and
   `parentId`; the JSONL stays a stream of bare events. A linear log already
   reads as the degenerate tree — zero migration.
2. **ULID on every event, from day one.** Identity must not depend on writer
   identity (collides under multi-machine divergence) nor file position.
3. **Parent default = current branch.** An event without `parentId` is a child
   of the branch the head points to; appending off-head makes `parentId`
   mandatory. A line's meaning never depends on reader state.
4. **Chrome events are tree nodes** (parented like everything else, topology-
   relevant, still excluded from model context).
5. **Split is implicit** — no marker event; a `parentId` that is not the head
   *is* the branch.
6. **`line:N` is a read-only bridge** to pre-tree events, never a second
   identity system.
7. **`session_start.schemaVersion` bumps honestly.** An old reader projects the
   new file linearly: degraded, documented, never corrupted.

### Head, chrome events, multi-machine divergence (#569)

1. **Head = the `to` of the last `branch_switched { to }`** in the file; none,
   the last event. `to` targets any node — switching to an interior node makes
   the next append split implicitly, so rewind is a case of switch (one
   primitive).
2. **The switch is appended immediately** (renameSession discipline: validate +
   append, last wins, no turn-boundary buffering).
3. **Switching does not consume** (ADR-0021 unchanged in principle):
   `session_resumed` stays the sole consumption marker, but consumption is
   computed **on the root→head path**, not on raw file positions.
4. **Resume reopens at head; fork inherits the whole tree** (byte-for-byte copy
   as today; abandoned branches come along).
5. **A turn is pinned to the head at turn start** — a mid-turn switch takes
   effect from the next turn; a turn is never split across branches.
6. **Multi-machine divergence becomes a legitimate implicit branch.** This
   changes #400 / ADR-0020 semantics: the foreign tail is a real sibling path in
   the tree, `session_file_growth` gains `localTip`/`foreignTip` in its payload,
   and the warning banner's primary action becomes **"keep my branch"** — a
   plain `branch_switched { to: localTip }`. Fork stays available as the
   secondary action. The "fork is the only escape" rule of ADR-0020 is hereby
   superseded; "explicit user action" remains (the switch is user-triggered).
7. **Dangling references degrade visibly, never silently** — an unresolvable
   head target or compaction `upToId` falls back with a visible warning chrome.

### Core semantics (#568)

1. **One projection, once: the active path.** Replay linearizes the file into
   the root→head path following `parentId` chains; every downstream consumer
   (`replayMessages`, `peekSession`, compaction index arithmetic, `EventLog.seed`)
   keeps its linear index logic, unmodified, fed the projection.
2. **Model context sees only the active path.** Switching branches is exactly
   how the model sees a different past; whole-tree context ("I already tried X")
   does not exist in this decision.
3. **Compaction covers the root→head path only**; markers resolve on-path (last
   marker on the path wins) and land on the branch actually summarized.
   ADR-0022's producer discipline is unchanged in shape.
4. **`moh compact` and forced compaction unchanged** (ADR-0022, including the
   "compacting never consumes" exception).

### Surfaces (#570)

1. **One client-facing seam:** `sessionTree(file)` on `@moh/core` (ADR-0004
   export) returns the precomputed `TreeView`.
2. **TUI `/tree`**: the ratified prototype-D frame — full topology tree,
   Home-picker interaction grammar, ←/→ navigation, strict visual row cap,
   contextual preview with the ⏎ consequence line.
3. **`Enter` switches live in-session; `r` branches from here** (sticky,
   dismissible banner; the first sent message carries the branch `parentId`).
4. **Bookmarks**: `tree_bookmarked { to, name? }` chrome events, append-only,
   last-wins, chrome-only; `b` toggles, `B` names; they power the branch
   filters (`f`).
5. **CLI**: `moh sessions tree | switch | bookmark` under the existing umbrella;
   `switch` refuses on a live writer; `--resume` reopens at head with no new
   flag.
6. **Light alignment**: the sessions manual page gains `/tree`, switch, and
   bookmark documentation in the implementing PR.

### Decided by implication (stated for honesty, normative here)

- **Extensions** see only the active path through existing seams (hooks,
  session events); the tree structure reaches clients through `sessionTree`
  only. No hook sees raw topology.
- **Trash/restore** is unchanged: deleting a session moves the whole file with
  all its branches (#478).

## Not decided here / future work

- **Pruning or archiving of abandoned branches** — never deletion; awaits a
  real size envelope from usage.
- **Whole-tree context** ("I already tried X on the other branch").
- **Per-path copies on fork** — future prune territory.

## Consequences

- The file format changes (`schemaVersion` bump); old readers degrade to linear
  projection — documented, never corruption.
- #400's `session_file_growth` recovery path changes (adopt-the-tail primary,
  fork secondary); ADR-0020's core principle (explicit user action) holds.
- Every positional consumer of the session file gains one shared dependency:
  the active-path projection. That is the keystone — once it exists, no other
  index-logic rewrite is needed.
- Fork stops being the primary "go back" mechanism but is not removed; tree and
  fork coexist by design.
