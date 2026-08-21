---
name: session-memory
description: Maintain structured session notes for continuity across conversations. Use at the start of any project session, when asked to remember work, resume a session, or save progress.
minMohVersion: 0.1.0
---

# Session Memory

Keep structured session notes at `~/.moh/projects/<project-slug>/session.md`. The `<project-slug>` is the lowercase `basename` of the working directory (spaces → hyphens), the same slug moh uses for session stores and memory.

## Path setup

```bash
PROJECT_SLUG=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
SESSION_FILE="$HOME/.moh/projects/$PROJECT_SLUG/session.md"
mkdir -p "$HOME/.moh/projects/$PROJECT_SLUG"
```

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
7. **No duplication**: do not repeat info already in the project's `AGENTS.md`, and do not restate durable facts already in moh memory topics (`~/.moh/projects/<slug>/memory/`) — session notes are for the *current* effort, memory for facts that outlive it
8. **Use `edit`** for precise in-place updates, never rewrite the whole file

## Typical workflow

### Session start — read the previous state
```bash
PROJECT_SLUG=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' '-')
cat "$HOME/.moh/projects/$PROJECT_SLUG/session.md" 2>/dev/null || echo "No previous session."
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
