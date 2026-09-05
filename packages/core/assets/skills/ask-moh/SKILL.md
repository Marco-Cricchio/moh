---
name: ask-moh
description: Ask which skill or flow fits your situation, or how moh itself works. A router over the first-party workflow skills and the moh documentation (extensions, skills, core library, config).
disable-model-invocation: true
minMohVersion: 0.1.0
---

# Ask moh

You don't remember every skill, so ask. This is a router: figure out what the user is trying to do, name the skill or flow that fits, and point at the moh documentation when the question is about moh itself.

## Workflow mode gate (read this first)

Every workflow skill below has a slash command (`/implement`, `/tdd`, …), and **those commands only exist while workflow mode is on**. The current state is injected into your prompt (`Workflow mode is currently on|off`).

When the user intends to **start a workflow** and workflow mode is **off**:

1. Say so plainly: workflow mode is off, and the workflow commands are unavailable until it's on.
2. Tell them to run **`/workflow on`** — you cannot toggle it yourself (it copies the first-party skills into `~/.moh/skills/`, records the manifest, and persists the toggle in the user config; that is TUI-side machinery, not something an agent turn can do).
3. Stop there. Once they have run `/workflow on` they can re-ask, and the full flow below applies.

Never suggest workarounds for a disabled workflow (no "read the SKILL.md from the bundle by hand") — the gate is the gate. With workflow mode **on**, route freely.

## The main flow: idea → ship

The route most work travels. You have an idea and want it built.

1. **`/grilling`** — sharpen the idea by interview. Start here. It is the interview primitive: rounds, the frontier, facts are the agent's job and decisions are the user's. When it runs inside a repo it should drive **`/domain-modeling`** to keep `CONTEXT.md` a clean glossary and record hard-to-reverse decisions as ADRs.
2. **Branch — is this a multi-session build?**
   - **Yes** → **`/to-spec`** (turn the thread into a spec), then **`/to-tickets`** to split it into tracer-bullet tickets, each declaring its **blocking edges**. On the moh tracker (GitHub Issues via `gh`, see `docs/agents/issue-tracker.md`) the edges become native blocking links. Kick off **`/implement`** per ticket, clearing context between each one.
   - **No** → **`/implement`** right here, in the same context window.

   Either way, **`/implement`** builds each issue by driving **`/tdd`** internally — one red-green slice at a time — then closes out by running **`/code-review`**, a two-axis review (Standards + Spec) of the diff, before committing. Reach for **`/tdd`** on its own for a concrete behaviour test-first, and **`/code-review`** whenever a branch or PR needs reviewing against a fixed point.

### Context hygiene

Keep steps 1–2 in one unbroken context window — don't compact or clear until after `/to-tickets` — so the grilling, spec, and tickets build on the same thinking. Each `/implement` then starts fresh, working from the ticket. If the session bloats before that, compact at the nearest phase boundary, never mid-phase.

## On-ramps

A starting situation that generates work, then merges onto the main flow.

- **Bugs and requests piling up** → **`/triage`**. It moves issues through triage roles and produces agent-ready issues (labels: `docs/agents/triage-labels.md`), which `/implement` later picks up. Only for issues **the user didn't create** — tickets from `/to-tickets` are already agent-ready.
- **Something's broken** → **`/diagnosing-bugs`**. For the bug that resists a first glance: it refuses to theorise until it has a tight feedback loop — one command that already goes red on *this* bug — then fixes with a regression test.
- **A huge, foggy effort — greenfield or a huge feature, too big for one session** → **`/wayfinder`**. It charts a shared map of **decision tickets** on the issue tracker and resolves them one at a time — decisions, not deliverables — until the way is clear. When the map clears, it hands off to `/to-spec`, which collapses the map into a buildable plan. Save wayfinder for efforts that genuinely don't fit one session; never a well-scoped feature.

## Codebase health

- **`/codebase-design`** — the deep-module vocabulary (module, interface, depth, seam, adapter, leverage, locality) for designing a module's shape. `/tdd` speaks it; reach for it directly when the *shape*, not the process, is the problem.

## Standalone

- **`/domain-modeling`** — sharpen the project's domain language: challenge a fuzzy term, resolve an overloaded word, record a decision as an ADR. Single-context layout: root `CONTEXT.md` + `docs/adr/` (see `docs/agents/domain.md`).
- **`/session-memory`** — structured session notes for continuity across conversations.
- **`/gh-manager`** — declarative, IaC-style GitHub repository management ("manage my GitHub footprint", "make my repos match repos.yaml", "standardize labels/branch protection across my repos"): init → plan → apply, with a consent-gated apply.
- **`/wizard`** — for steps only a **human** can take: provisioning, credentials, CI secrets, unfamiliar dashboards, one-off migrations. It generates an interactive bash script the human runs.
- **`/writing-for-agents`** — reference for writing documents agents consume: skills, AGENTS.md, pointed-at docs.

## The user manual (grounded answers about moh)

moh ships a user manual: ten pages bundled in the binary, mirrored in
**`docs/manual/`** in the repo (read them there; never guess). When the
user's question is about how moh itself works — sessions, fork/resume,
permissions, providers, MCP, workflow mode, config keys, CLI flags —
open the page that covers it, answer **from that page**, and cite the
section as `Manual → <Title>`. If no page clearly fits, say so and
point at the closest one rather than inventing detail.

## moh documentation (know where to look)

**Scope gate first:** the paths below exist only **inside the moh repository
itself** (contributor docs). If the current project is not the moh repo — a
user project, a fresh directory, anything without `docs/extending/` — skip
this section entirely: do not probe for these files, answer from the **user
manual** above (it is bundled in the binary and always available).

Inside the moh repo, the docs live in the project root — read them, don't guess. The single source of truth for terminology is **`CONTEXT.md`** (the glossary above quotes it). Key entry points:

- **`docs/extending/index.md`** — the extending docs' front door, split by persona (extension writer vs library user). **`docs/extending/extensions.md`** is the authority on the `@moh/extension` contract: phase hooks (`beforeModelCall`, `onToolCall`, …), the restrict-only veto, lifecycle. **`docs/extending/skills.md`** covers skill format, discovery (`~/.moh/skills/` < `.moh/skills/`, project wins), progressive disclosure, and first-party skill ownership. **`docs/extending/library-usage.md`** covers embedding the core.
- **`docs/principles.md`** — the seven architecture principles; a change that violates one needs an explicit ADR.
- **`docs/adr/`** — the recorded decisions (public-surface criterion, user-config guardian, session assembly, auth, …).
- **`docs/agents/`** — how the agent operates: issue tracker (`gh` + GitHub Issues), triage labels, domain docs layout.
- **`AGENTS.md`** — repo conventions: English artifacts, Italian conversation, `develop` as the integration branch.

When a question touches extensions or the core library, open the relevant `docs/extending/` chapter before answering; cite the file you used.
