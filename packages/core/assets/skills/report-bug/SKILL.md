---
name: report-bug
description: File a bug or feature request against the moh repository on behalf of the user. Collects environment info and version, drafts the issue, and publishes it through the user's authenticated gh (with confirmation) — or hands over the web fallback when gh is missing.
minMohVersion: 0.1.0
---

# Report a bug or request

File an issue against the moh repository (`Marco-Cricchio/moh`) for the user.
The user's own `gh` account does the publishing — moh never supplies
credentials, and nothing leaves the machine without the user's explicit
confirmation (the permission prompt on the `gh` call is part of the flow, not
an obstacle).

## Before anything else

Check whether `gh` is installed and authenticated:

```
gh auth status
```

- **gh available** → follow the full flow below.
- **gh missing or unauthenticated** → fall back: give the user the web link —
  https://github.com/Marco-Cricchio/moh/issues/new/choose — and pre-draft the
  issue body in a scratch block they can paste. Stop there; do not attempt to
  authenticate on their behalf.

## Collect the report

Gather (do not invent) the facts a maintainer needs:

1. **What happened**, in the user's words, plus what they expected.
2. **Reproduction steps**, if it's a bug — ask only if the user hasn't already
   described them.
3. **Environment**: `moh --version`, OS + arch (`uname -sm`), how it was
   installed (binary / from source).
4. **Relevant context from this session**, only with consent: the failing
   command or tool call, and at most a short excerpt of the related event-log
   lines. **Never** include session file paths, memory contents, or project
   file contents by default — the session log may contain code or secrets.
   Ask before attaching anything beyond the environment line.

## Draft and confirm

Compose the issue as markdown. Start the body with a single environment
block:

```
- moh version: <version>
- OS: <os/arch>
- Install: <binary|source>
```

For bugs, include **Steps to reproduce**, **Expected**, **Actual**. For
feature requests, include **Problem** and **Proposed solution**.

Show the full draft to the user — title, body, and the exact command you will
run:

```
gh issue create --repo Marco-Cricchio/moh --title "<title>" --body-file <tmpfile>
```

Publish only after the user approves. Writing the body to a temp file keeps
quoting safe for long markdown.

## After publishing

Report the issue URL back to the user and offer to keep the conversation
going there (the maintainer may come back with follow-up questions).
