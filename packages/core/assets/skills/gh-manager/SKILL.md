---
name: gh-manager
description: "Declarative, IaC-style GitHub repository management: keep repos, labels and branch protection in sync with a declared repos.yaml via init → plan → apply. Use when the user wants to make their repos match a declaration, standardize labels or branch protection across repositories, or audit drift between declared and live GitHub settings. Ported from gh-manager by David Lawson (@ddlaws0n), MIT."
minMohVersion: 0.1.0
---

# gh-manager

Manage GitHub repository settings declaratively: a single `repos.yaml`
declares the desired state of repos (description, visibility, labels,
branch protection); a **plan** diffs it against live state; **apply**
reconciles the two. Never mutate anything without showing the diff and
getting explicit consent.

Ported from [gh-manager](https://github.com/ddlaws0n/gh-manager) by
David Lawson ([@ddlaws0n](https://github.com/ddlaws0n)), MIT.

## Ground rules

- **`plan` is always read-only.** Never call anything mutating before the
  consent gate below, not even "just to check".
- **The consent gate is non-negotiable.** Before apply, show the rendered
  plan and ask via `ask_user` (suggested: the safe option). One consent
  covers exactly the shown plan; a changed plan needs fresh consent.
- **Access goes through `gh`** (`gh auth status` first). Never handle
  tokens yourself; `GITHUB_TOKEN`/`gh auth login` is the user's business.
  If `gh` is missing or unauthenticated, say so and stop — propose the
  `wizard` skill if the user wants guided setup.
- **Undeclared ≠ delete.** Live settings the declaration doesn't mention
  (extra labels, other branches' protection) are never touched. Report
  them as drift context, nothing more.

## The flow: init → plan → apply

### 1. init

If no `repos.yaml` exists, create one by reading the user's current state
(read-only `gh api repos/<owner>/<repo>`, `.../labels`,
`.../branches/main/protection`) and rendering it as the starting
declaration. Confirm scope with the user first: which repos (or org), and
whether to start from live state (recommended — first apply is then a
no-op) or from a clean slate.

The file format (JSON projection; keep it valid YAML):

```yaml
repos:
  - name: owner/repo            # required, owner/name
    description: ...
    visibility: public | private
    labels:
      - name: bug               # required
        color: d73a4a           # 6 hex digits, no '#'
        description: ...
    branchProtection:
      branch: main              # default: main
      requiredChecks: [ci]
      requiredReviews: 1        # 0–6
      dismissStaleReviews: false
      allowForcePushes: false
```

### 2. plan

Diff the declaration against live state and present the result. The
reference implementation of the planner lives in
`packages/core/src/github-settings.ts` in the moh repo — the semantics it
pins are binding here:

- Per repo, compute the **minimal** change set: only drifted fields of
  repo settings; missing or drifted labels (color/description, compared
  case-insensitively); branch protection when absent, drifted, or declared
  on a branch that isn't the protected one.
- Present it as a rendered diff, one line per change, in order:
  repo settings → labels → branch protection. An empty plan means "live
  state already matches" — say so and stop.

### 3. apply (consent-gated)

1. Show the rendered plan from step 2 verbatim.
2. Ask consent with `ask_user`: options `Apply` / `Not now`
   (suggested: `Not now` unless the user already drove here deliberately
   and the changes match exactly what they asked for).
3. Only on explicit approval, execute the plan's changes in order, one
   GitHub API call each, and report each applied change. On a mid-plan
   failure, stop immediately and report what was applied and what remains
   — never retry automatically.
4. Re-plan after apply to confirm zero drift.

## Tips

- Multi-repo standardization ("same labels/protection everywhere") is
  just a `repos.yaml` with repeated stanzas — plan once, apply per repo,
  with one consent covering the whole shown plan.
- A dry run is simply step 2. Users who ask for "what would change" get
  plan only; never fall through to apply.
