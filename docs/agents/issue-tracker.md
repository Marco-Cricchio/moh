# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Auto-close never fires here: closing keywords are inert, close by hand

**Root cause (verified 2026-10-03): the repo's default branch is `main`, but
every PR targets `develop`.** GitHub processes `Closes/Fixes/Resolves #N` only
when the merge lands on the **default branch**. Since nothing in this repo ever
merges into `main` except an explicit promote, a closing keyword in a PR body
is **inert by construction** — the linked issue always stays open.

Do not diagnose this per-PR as a merge-commit or missing-keyword problem
(easy to do, and wrong): across #1125–#1132, PRs with the keyword and PRs
without it behaved identically — every issue needed a manual close. The
keyword is harmless documentation; it is never the mechanism.

**Therefore, after every merge:** close the left-open issues by hand, with a
pointer to the PR that landed them.

```bash
gh issue view <N> --json state --jq .state   # expect CLOSED; if OPEN, close it
gh issue close <N> --comment "Landed via #<pr> (merged into develop). Closing manually: PRs here target develop while the repo default branch is main, so closing keywords never fire."
```

Corollary for multi-agent lanes: **a lane that merges a PR must close its own
issue** in the same breath — no other lane will notice it, and the frontier
stays wrong until someone does. This happened repeatedly across the #1000
series; the close is part of "done", not cleanup.

When the closed issue is a **blocker** of other tickets (wayfinder map or
`Blocked by` edges), recompute the frontier afterwards: a blocker closed by
hand unblocks its children exactly like a native close, but nothing announces
it — check the children's `issue_dependencies_summary.blocked_by` / `Blocked by`
lines before telling the user what is now actionable.

Closing with the keyword costs nothing and documents the link, but it is not
what closes the issue here — the manual close is. Treat "opened a PR with
`Closes #N`" as an open action on the tracker until the hand close lands.

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
