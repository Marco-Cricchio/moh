# ADR-0043: the branch-scoped fork is a degenerate linear projection

Status: accepted · Date: 2026-09-21 · Parent: issue #768 · Related: ADR-0020, ADR-0021, ADR-0023, #578

## Context

Fork is a full-file copy: `SessionStore.fork()` copies the whole `.jsonl`
and appends `session_resumed` (forks born consumed). With in-file trees
(ADR-0023) a session can hold many branches, and forking copies all of
them even when the user wants only the current one. A **scoped fork** —
`fork(scope: "tree" | "branch")` — extracts the active branch into its
own small session, and doubles as the way to slim a heavy file.

The open question was the replay semantics of the copy: a filtered log
must stay a valid tree, and chrome referencing dropped nodes (switch
markers, bookmarks, compaction pointers) must not dangle silently.

## Decision

**Go: `"branch"` writes the active root→head path (`activePath`) as a
valid degenerate linear tree — parent chains stripped, file order is the
path. `"tree"` (the default) keeps today's byte-identical full copy.**

- **Strip, don't re-root.** Projected events lose their `parentId`: the
  chains name the *source* file's topology, and a parentless linear log
  is already the degenerate tree every reader certifies. Ids are
  preserved, so id-addressed pointers survive untouched.
- **Source-tree head markers are dropped.** `branch_switched` describes
  where the source file's head went; the fork is single-pathed, and a
  kept marker's `to` may name a dropped sibling.
- **Bookmarks ride their target.** A `tree_bookmarked` survives only
  when its target survives; the pointer is rewritten to the target's id
  (`line:N` refs would shift in the shorter copy). A bookmark to a
  dropped node is dropped.
- **Compaction pointers are remapped or dropped, never shifted.** A
  `line:N` pointer converts to the target's id when the target is on the
  path; otherwise it is dropped, leaving the visible dangling-restart
  warning — the same "never silent mis-replay" discipline as #578.
  Legacy numeric pointers remap to the new path index, or drop.
- **Scope is a per-call argument, not a new door.** One fork seam, two
  behaviors; the CLI expresses it as `--fork-scope tree|branch` (the
  boolean `--fork` keeps its bare form), the TUI as `/fork [tree|branch]`
  behind the existing growth-warning gate.

## Consequences

- A branch fork starts clean: no dangling off-path markers, and it
  composes with path-scoped compaction (#578) — a compaction marker on
  the path travels with the projection.
- The copy is not byte-comparable with its source (unlike `"tree"`):
  parentIds and source-tree chrome are gone by construction. Tests pin
  the projected shape, not a byte prefix.
- `branchProjection` stays internal (ADR-0004): clients reach the
  behavior only through `fork(scope)`.

## Alternatives considered

- **Re-rooting the copied branch with fresh parent chains** — rejected:
  it invents topology the reader cannot distinguish from a real tree,
  for no reader benefit over the degenerate linear form.
- **`--fork branch|tree` as one value-taking flag** — rejected at the
  CLI grammar level: `--fork` is a boolean flag whose bare form must
  keep working; the argv parser would need a new optional-value kind.
