# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (usually loaded alongside `/grilling`, e.g. from `/wayfinder`) creates them lazily when terms or decisions actually get resolved.

**Publishing posture (moh repo):** `CONTEXT.md`, `docs/principles.md` and `docs/adr/` are **tracked and public** — they document the architecture for contributors and extension writers and ship with the repo. Keep the light-alignment rules: a glossary-relevant PR updates `CONTEXT.md` in the same PR; a decision gets its ADR before merge. The agent setup is **tracked and public** too, so every clone and git worktree carries it: `AGENTS.md`, `CLAUDE.md` (it only imports `AGENTS.md`), and `docs/agents/{issue-tracker,triage-labels,domain}.md`. What stays local-only (gitignored): `docs/spec/`, `docs/vision/`, `docs/research/` and any other file under `docs/agents/` (drafts, operator notes) — planning artifacts, never referenced by public docs or issues by path.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
