---
name: session-memory
description: Maintain structured session notes for continuity across conversations. Use at the start of any project session, when asked to remember work, resume a session, or save progress.
minMohVersion: 0.1.0
---

# Session Memory

Keep structured session notes at `~/.moh/projects/<project-slug>/session.md`, in the same project directory moh uses for session files and memory.

The `<project-slug>` is moh's exact slug rule (see `projectSlug` in `packages/core/src/session-store.ts`): the sanitized lowercase basename of the resolved working directory (every run of characters outside `[a-z0-9._-]` becomes one `-`, leading/trailing `-` trimmed, `project` if empty), followed by `-` and the first 8 hex chars of the SHA-256 of the resolved absolute path. The hash makes the slug unique per project location.

## Path setup

```bash
SLUG_BASE=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')
[ -n "$SLUG_BASE" ] || SLUG_BASE="project"
SLUG_HASH=$(printf '%s' "$(pwd -P)" | { command -v shasum >/dev/null 2>&1 && shasum -a 256 || sha256sum; } | cut -c1-8)
SESSION_DIR="$HOME/.moh/projects/$SLUG_BASE-$SLUG_HASH"
SESSION_FILE="$SESSION_DIR/session.md"
mkdir -p "$SESSION_DIR"
```

(Use `pwd -P`, not `$PWD`, for the hash: the core hashes the resolved absolute path, and a logical path through a symlink would produce a different slug.)

## Structured template

When creating a new file, use **exactly** this template:

```markdown
# Session Title
_Descriptive 5-10 words, info-dense, no filler_

# Current State
_What is being worked on RIGHT NOW. Pending, incomplete tasks. Immediate next steps._

# Task Specification
_What the user asked for. Design decisions and explanatory context._

# Files and Functions
_Important files: what they contain and why they are relevant._

# Workflow
_Bash commands usually used and in what order. How to read the output._

# Errors & Corrections
_Errors encountered and how they were resolved. What the user corrected. Failed approaches not to repeat._

# Learnings
_What worked? What didn't? What to avoid? Do not duplicate other sections._

# Key Results
_If the user asked for a specific output (table, answer, document), include the exact result here._

# Worklog
_Step-by-step: what was attempted/done. Terse one-line summary per step._
```

## Update rules

Always respect these rules when updating the file:

1. **Preserve structure**: never modify the `# Header` lines or the `_italic description_` lines — they are part of the template
2. **Update only the content** below each section's description line
3. **High signal only**: dense info, no filler, no needless elaboration
4. **Current State is critical**: always update it to reflect the latest work — it is the re-entry point for the next session
5. **Sections with nothing new**: leave unchanged, never write "no updates" or similar
6. **Per-section size**: max ~2000 words; when near the limit, cycle out the least important detail
7. **No duplication**: do not repeat info already in the project's `AGENTS.md`, and do not restate durable facts already in moh memory topics (`~/.moh/projects/<project-slug>/memory/`) — session notes are for the *current* effort, memory for facts that outlive it
8. **Use `edit`** for precise in-place updates, never rewrite the whole file

## Typical workflow

### Session start — read the previous state
```bash
SLUG_BASE=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')
[ -n "$SLUG_BASE" ] || SLUG_BASE="project"
SLUG_HASH=$(printf '%s' "$(pwd -P)" | { command -v shasum >/dev/null 2>&1 && shasum -a 256 || sha256sum; } | cut -c1-8)
cat "$HOME/.moh/projects/$SLUG_BASE-$SLUG_HASH/session.md" 2>/dev/null || echo "No previous session."
```
Report a summary of "Current State" and next steps found.

### During the session — update after significant tasks
Use the `edit` tool to update the relevant sections: at minimum "Current State" and "Worklog".

### Session end — final checkpoint
Make sure "Current State" describes exactly where work stopped and the next steps.

## Example of a well-written Current State

```
JWT auth implementation complete (src/auth/jwt.ts).
Unit tests written but failing on refresh token (see Errors).
NEXT: fix refreshToken() and add integration tests.
```

## Notes

- The file is Markdown — use `read` to load it, `edit` to update it
- Keep the "Session Title" current if the work's focus changes significantly
- "Worklog" is a terse chronological list — one bullet per step, no paragraphs
