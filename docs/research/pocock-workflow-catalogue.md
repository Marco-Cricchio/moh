# Matt Pocock Engineering Workflow — Catalogue

Research ticket #6. Primary sources: the installed skills in `/Users/mc/.pi/agent/skills/` (each `SKILL.md` and its companion reference docs), plus this repo's configured artifacts (`AGENTS.md`, `docs/agents/*.md`, `docs/adr/` layout). Every claim below cites the skill file it comes from.

## 1. Big picture

The workflow is a **spec-first, agent-first SDLC** built around three ideas:

1. **Everything routes through the issue tracker.** Specs, tickets, decision maps, agent briefs — all are issues, labelled and linked, so humans and AFK agents share one queue. (triage/SKILL.md, to-tickets/SKILL.md, wayfinder/SKILL.md, docs/agents/issue-tracker.md)
2. **The domain glossary is the shared language.** `CONTEXT.md` (glossary) + `docs/adr/` (decisions) are read before exploring code and updated the moment terms/decisions crystallize. (domain-modeling/SKILL.md, docs/agents/domain.md)
3. **Agents work from durable, behavioral briefs — never file paths or procedures.** Durability over precision; behavioral, not procedural; acceptance criteria; explicit out-of-scope. (triage/AGENT-BRIEF.md)

## 2. Setup (once per repo): `/setup-matt-pocock-skills`

Scaffolds three configuration files, referenced from an `## Agent skills` section in `AGENTS.md` (or `CLAUDE.md`):

| Artifact | Path | Contents |
|---|---|---|
| Issue tracker config | `docs/agents/issue-tracker.md` | Tracker backend (GitHub/GitHub `gh` CLI / GitLab / local markdown under `.scratch/`), CLI recipes, "PRs as a request surface" flag (default off), Wayfinding operations (map/child/blocking/frontier/claim/resolve) |
| Triage label vocabulary | `docs/agents/triage-labels.md` | Maps 5 canonical roles → actual label strings |
| Domain doc layout | `docs/agents/domain.md` | Single-context (`CONTEXT.md` + `docs/adr/`) vs multi-context (`CONTEXT-MAP.md` + per-context `src/<ctx>/CONTEXT.md`), consumer rules (read silently if present, use glossary vocabulary, flag ADR conflicts) |

In this repo (moh): GitHub Issues via `gh`, default labels kept, single-context layout.

## 3. The end-to-end flow

```
loose idea ──▶ wayfinder (map of decision tickets)          [if too big for one session]
                  │  grilling + domain-modeling → destination, tickets
                  ▼
             grilling + domain-modeling                       [design tree, frontier rounds]
             prototype (LOGIC.md / UI.md branches)            [raise fidelity, throwaway]
                  │
                  ▼
             /to-spec ──▶ spec issue, label ready-for-agent   [spec template]
                  │
                  ▼
             /to-tickets ──▶ tracer-bullet tickets w/ blocking edges, label ready-for-agent
                  │
                  ▼
             /triage ──▶ state machine, agent briefs          [also handles inbound issues/PRs]
                  │
                  ▼
             /implement ──▶ /tdd (seams) ──▶ /code-review     [red→green, two-axis review]
                  │                                           (diagnosing-bugs when broken)
                  ▼
             commit / PR  (pr-review for inbound PRs)
```

### 3.1 Wayfinding — `/wayfinder`

For work too big for one agent session: chart a **map** (single issue labelled `wayfinder:map`) holding Destination / Notes / Decisions-so-far / Not-yet-specified (fog) / Out-of-scope. Child **decision tickets** carry `wayfinder:<type>` labels: `research` (AFK), `prototype` (HITL), `grilling` (HITL), `task`. Native tracker blocking renders the frontier visually. One ticket per session (research excepted); claim by assigning first; resolve with a resolution comment + close + context pointer appended to the map. Planning by default — produce decisions, not deliverables. (wayfinder/SKILL.md; docs/agents/issue-tracker.md "Wayfinding operations")

### 3.2 Design — `grilling` + `domain-modeling` (+ `prototype`)

- **grilling**: relentless interview as a **design tree**, worked in rounds over the **frontier** (questions whose prerequisites are settled). Facts are the agent's job (sub-agents), decisions are the user's. Done when the frontier is empty. (grilling/SKILL.md)
- **domain-modeling**: challenge terms against the glossary, sharpen fuzzy language, stress-test with scenarios, cross-reference with code; update `CONTEXT.md` inline as terms resolve; offer ADRs sparingly (hard to reverse + surprising + real trade-off — all three, else skip). (domain-modeling/SKILL.md, CONTEXT-FORMAT.md, ADR-FORMAT.md)
- **prototype**: throwaway code that answers a question — LOGIC.md branch (shareable HTML state-machine walkthrough) or UI.md branch (multi-variant route). Committed to a throwaway branch, out of main, with a context pointer left on the issue; only the validated decision lands on main. (prototype/SKILL.md)

### 3.3 Spec — `/to-spec`

Synthesizes (no interview) the conversation into a spec published as an issue, label `ready-for-agent`. Template sections: Problem Statement, Solution, User Stories (long numbered list, "As an actor, I want…, so that…"), Implementation Decisions, Testing Decisions, Out of Scope, Further Notes. Seams are sketched and confirmed with the user first — prefer existing seams, highest seam possible, ideal number is one. No file paths or code snippets (exception: prototype-derived decision snippets). (to-spec/SKILL.md)

### 3.4 Tickets — `/to-tickets`

Breaks the spec/conversation into **tracer-bullet vertical slices**: each cuts a complete path through every layer, demoable on its own, sized to one fresh context window, with explicit **blocking edges**. Prefactoring first ("make the change easy, then make the easy change"). Exception: **wide refactors** sequenced as expand–contract (expand → migrate batches → contract), optionally on an integration branch. User quizzes the breakdown, then tickets publish in dependency order with `ready-for-agent`. Local tracker: one file per ticket under `.scratch/<feature-slug>/issues/<NN>-<slug>.md` using the local-ticket template; GitHub: one issue per ticket with native blocking. Never close/modify parent issues. (to-tickets/SKILL.md)

### 3.5 Triage — `/triage`

State machine over issues (and external PRs when the flag is on): one category role (`bug`/`enhancement`) + one state role per issue. States: `needs-triage` → (`needs-info` ↔ back) / `ready-for-agent` / `ready-for-human` / `wontfix`. Process: gather context (read body/comments; redundancy check — search for existing implementation by domain concept; prior-rejection check against `.out-of-scope/*.md`) → recommend → **verify the claim** (reproduce bug / confirm PR diff does what it claims) → grill if needed (grilling + domain-modeling) → apply outcome. Every AI-generated comment starts with `> *This was generated by AI during triage.*`. Outcomes: `ready-for-agent` posts an **agent brief**; `wontfix` closes (rejected enhancements write to `.out-of-scope/` KB, one file per concept; already-implemented ones don't); `needs-info` posts Triage Notes (established-so-far / what-we-need) using the template. (triage/SKILL.md, AGENT-BRIEF.md, OUT-OF-SCOPE.md)

### 3.6 Implementation — `/implement` + `tdd` (+ `diagnosing-bugs`)

- **implement**: work the spec/tickets; TDD at pre-agreed seams; typecheck regularly, single test files regularly, full suite once at the end; then `/code-review`; commit to current branch. (implement/SKILL.md)
- **tdd**: red→green loop. Tests verify behavior through public interfaces at **pre-agreed seams** (confirmed with the user; consult codebase-design when the seam's location is itself in question). Anti-patterns: implementation-coupled, tautological, horizontal slicing (work vertical tracer bullets instead). Refactoring is NOT part of the loop — it belongs to code-review. (tdd/SKILL.md)
- **diagnosing-bugs**: Phase 1 build a tight, red-capable, deterministic, fast, agent-runnable feedback loop ("this is the skill"); Phase 2 reproduce + minimise; Phase 3 3–5 ranked falsifiable hypotheses; Phase 4 instrument one variable at a time, tagged `[DEBUG-xxxx]` logs; Phase 5 regression test before fix (correct seam required — if none exists, that itself is the finding); Phase 6 cleanup, winning hypothesis in the commit message. (diagnosing-bugs/SKILL.md)

### 3.7 Review — `code-review` (+ `pr-review`)

- **code-review**: two-axis review of `git diff <fixed-point>...HEAD` run as **parallel sub-agents**: **Standards** (documented repo standards + fixed Fowler smell baseline, repo overrides baseline, smells always judgement calls) vs **Spec** (missing/partial requirements, scope creep, wrong-looking implementations, quoting the spec). Spec source found via commit issue refs → arg path → spec file → ask. Axes reported separately, never merged or reranked. (code-review/SKILL.md)
- **pr-review**: category-based checklist review (security/performance/quality/testing) with 🔴/🟡/🟢/✅ output format. (pr-review/SKILL.md)

### 3.8 Cross-cutting

- **codebase-design**: shared vocabulary (module, interface, seam, adapter, depth, leverage, locality) consulted by other skills — especially tdd on seam placement. Deep modules = small interface, lots of behaviour. (codebase-design/SKILL.md)
- **session-memory**: structured `~/.pi/memory/<project-slug>/session.md` with fixed sections (Current State, Task Spec, Files, Workflow, Errors, Learnings, Key Results, Worklog); edit-in-place, preserve headers, update Current State every checkpoint. (session-memory/SKILL.md)
- **writing-for-agents**: meta-reference for writing agent-consumed docs. **Context pointers** (wording decides firing) vs the **two loads** (context vs cognitive) vs the **information hierarchy** (in-file step → in-file reference → disclosed reference). (writing-for-agents/SKILL.md, SKILL-MECHANICS.md)

## 4. Artifact map

| Artifact | Producer | Consumer | Notes |
|---|---|---|---|
| `AGENTS.md` / `CLAUDE.md` `## Agent skills` | setup-matt-pocock-skills | all skills | context pointers to the three config docs |
| `docs/agents/issue-tracker.md` | setup | to-spec, to-tickets, triage, code-review, wayfinder | tracker + wayfinding operations |
| `docs/agents/triage-labels.md` | setup | triage | role→label mapping |
| `docs/agents/domain.md` | setup | all explorers | CONTEXT/ADR layout + rules |
| `CONTEXT.md` (+ `CONTEXT-MAP.md`) | domain-modeling | everyone exploring code | glossary only, no implementation detail |
| `docs/adr/000N-slug.md` | domain-modeling | everyone | minimal template, offered sparingly |
| Spec issue (`ready-for-agent`) | to-spec | to-tickets, implement, code-review | spec template |
| Ticket issues w/ blocking edges (`ready-for-agent`) | to-tickets | implement, triage | tracer-bullet slices; `.scratch/` local variant |
| Map issue (`wayfinder:map`) + child tickets (`wayfinder:<type>`) | wayfinder | wayfinder sessions | frontier = open, unblocked, unclaimed |
| Agent brief comment | triage | AFK agents | durable/behavioral contract |
| `.out-of-scope/*.md` | triage (wontfix: rejected) | triage (prior-rejection check) | one file per concept |
| Prototype branch | prototype | wayfinder/to-spec | context pointer left on issue; decision folded into main |
| Regression tests at seams | tdd, diagnosing-bugs | CI | red→green; minimised repro |
| Session memory file | session-memory | next sessions | fixed 9-section template |

## 5. Conventions summary

- **Labels**: triage states `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix` + categories `bug` / `enhancement`; wayfinder `wayfinder:map` and `wayfinder:research|prototype|grilling|task`.
- **Disclaimer**: every triage-generated tracker comment opens with `> *This was generated by AI during triage.*`
- **Durability rule**: no file paths, line numbers, or code snippets in specs/tickets/briefs (prototype-derived decision snippets excepted).
- **ADRs**: sequential `0001-slug.md`, minimal template, only when hard-to-reverse ∧ surprising ∧ real-trade-off.
- **Ticket shape**: vertical tracer bullets, one-context-window sized, explicit blocking edges, published dependency-first; wide refactors via expand–contract.
- **Blocking edges**: tracker-native dependencies preferred (GitHub sub-issues + blocked_by API in this repo); fallback `Blocked by: #n` body line.
- **Prototype capture**: throwaway branch + context pointer; main keeps only the validated decision.

## 6. Sources

- Skills read in full: grilling, domain-modeling (incl. CONTEXT-FORMAT.md, ADR-FORMAT.md), to-spec, to-tickets, triage (incl. AGENT-BRIEF.md, OUT-OF-SCOPE.md), implement, tdd, code-review, wayfinder, session-memory, writing-for-agents, codebase-design, diagnosing-bugs, pr-review, prototype, setup-matt-pocock-skills — all under `/Users/mc/.pi/agent/skills/`.
- Repo config: `AGENTS.md`, `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md` in this repo.
