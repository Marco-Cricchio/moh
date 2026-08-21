# moh

## Language

All repo artifacts (issues, PRs, comments, docs, code, commit messages) are in **English**. All conversation with the owner across moh sessions is in **Italian**. Never ask about this again.

## Branching

The integration branch is **`develop`**. Always create PRs targeting `develop` (base branch: `develop`), never `main`. `main` is only updated by promoting from `develop` (explicitly requested by the owner). Never merge a PR into `main`.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (Marco-Cricchio/moh) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default triage label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
