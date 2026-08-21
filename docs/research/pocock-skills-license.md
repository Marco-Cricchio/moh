# License & Attribution Check — Matt Pocock Skills

Ticket #71 (tracer bullet 1 of #67). Decides whether moh can redistribute the skill texts verbatim, or must ship faithful rewrites. Every claim below cites a primary source.

## Verdict

**Verbatim redistribution is permitted.** The upstream repository is MIT-licensed; MIT requires only that the copyright notice and permission notice be included in redistributions. No rewrite is required. Bundle the texts as-is (or with the light local edits noted below), shipping a copy of the MIT license and an attribution notice.

## Primary sources

| Claim | Source |
|---|---|
| Upstream repo is `mattpocock/skills` ("Skills for Real Engineers. Straight from my .agents directory.") | GitHub API `search/repositories?q=user:mattpocock+skills` |
| License: **MIT** | GitHub API `repos/mattpocock/skills` → `license.spdx_id: MIT`; `raw.githubusercontent.com/mattpocock/skills/main/LICENSE` |
| Copyright holder and year | `LICENSE` line 3: "Copyright (c) 2026 Matt Pocock" |
| Skill texts live under `skills/{engineering,productivity,misc}/` | GitHub API `contents/skills` and subdirectories |

Upstream layout (skills/): `engineering/` (ask-matt, code-review, codebase-design, diagnosing-bugs, domain-modeling, grill-with-docs, implement, improve-codebase-architecture, prototype, research, resolving-merge-conflicts, setup-matt-pocock-skills, tdd, to-spec, to-tickets, triage, wayfinder, wizard), `productivity/` (grill-me, grilling, handoff, teach, to-questionnaire, wait-what, writing-for-agents), `misc/`, `deprecated/`, `in-progress/`.

## Relationship between local copies and upstream

Diffed three representative skills against upstream `main` (`skills/engineering/{tdd,code-review}`, `skills/productivity/grilling`):

- The local texts in `~/.pi/agent/skills/` are **substantively identical** to upstream, with light cosmetic edits: typographic punctuation swaps (colons → em-dashes), minor reworded intros ("Each question should be formatted like so" vs "Format a round like so"), and removed emoji blocks in grilling.
- No local skill carries its own license or attribution notice; the only licensing terms are upstream's.

This means the local texts are **derivatives of MIT-licensed work**. Both verbatim copies and edited derivatives are permitted under MIT, subject to the notice requirement.

## Compliance obligations when bundling (per MIT)

1. Include the MIT **copyright notice** ("Copyright (c) 2026 Matt Pocock") and the full permission notice — e.g. a `LICENSE-third-party.md` (or per-directory `LICENSE`) alongside the bundled skills.
2. Attribute the source repo (`https://github.com/mattpocock/skills`) in the same notice.
3. Record the upstream commit(s) the texts were taken from, so future license audits can trace provenance.
4. Do not imply endorsement (MIT doesn't require this, but good practice for a public repo).

## Consequences for #67 and children

- #72, #73, #74 (port batches): bundle **verbatim from upstream**, with the attribution notice above. No rewrite pass needed.
- Since local copies differ cosmetically from upstream, prefer **upstream `main` as the source of truth** when porting, not the local `~/.pi/agent/skills/` copies, and note any intentional deviations in the porting PR.
