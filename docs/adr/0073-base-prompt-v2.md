# ADR-0073: Base prompt v2 — harness behavior distilled from the Claude Code and Codex prompt corpora

Status: accepted · Date: 2026-10-04 · Related: ADR-0072 (moh_docs, whose prompt sentence v2 carries), #27 (PromptComposer)

## Context

moh's shipped base prompt was ~260 tokens: seven rules covering concision,
tool honesty, exploration economy, project instructions, language, and
bash payload hygiene. The harnesses moh competes with ship an order of
magnitude more behavioral instruction in their system prompts (Codex
GPT-5.2 ~900 tks; Claude Code thousands, across conditional sections —
see the Piebald-AI/claude-code-system-prompts corpus, 515 prompts).
The gap is not length but whole missing instruction classes: user-facing
communication during tool use, blast-radius safety, code hygiene,
turn-final delivery, and decisiveness. Model behavior degrades exactly
where the harness says nothing.

## Decision

The base prompt grows from 7 rules to ~550 tokens in six titled sections
(Core behavior / Communicating / Code / Actions / Working / Security),
each rule distilled from the two corpora and compressed to moh's
imperative style. Class sources:

- **Communicating** — Claude Code "communication style" +
  "outcome-first": text is what the user reads (not tool calls); one
  sentence at the start of each turn, then silent work with updates only
  at load-bearing moments; outcome-first final message; final-message
  completeness (no trailing tool calls); readable over compressed.
  The outcome-first *variant containing "readable > concise" was
  excluded* — that rule already lives in moh's Lessons.
- **Code** — Claude Code "no unnecessary additions / no compatibility
  hacks / no unnecessary error handling / comment why-only": no scope
  creep, no speculative error handling, boundary-only validation,
  comments only for non-obvious whys, match surrounding idiom.
- **Actions** — Claude Code "executing actions with care" +
  "action safety and truthful reporting", compressed to three rules:
  local-reversible free vs confirm shared/irreversible (durable
  authorization, one-approval scope), look before delete / investigate
  unexpected state (reversible step preferred), faithful outcome
  reporting.
- **Working** — Claude Code "act when ready" + "delivering work":
  decide with enough information, recommend don't survey; routine
  judgment calls stated as assumptions, questions only on material
  divergence.
- **Security** — Claude Code "doing tasks (security)": no OWASP-class
  vulnerabilities, fix on sight.

**Excluded, with reasons:** Codex frontend aesthetics (opinionated
taste, not harness-neutral); granular todo rules (moh's todo tool owns
its flow); Claude-Code memory files (conflicts with moh's
session-memory/event-log model); emoji avoidance (client-side concern);
the "ambitious tasks" section (vague, tension with moh's discipline).

**Token budget:** ~260 → ~550 (+~290 per model call), accepted because
every added rule is harness-universal (tool- and project-agnostic) and
the composer reassembles per call — a constant, not a per-turn cost.

## Consequences

- The `promptVersion` hash shifts; informational.
- Prompt-matching tests are the known hazard (#1195's "first"): the v2
  text was chosen to avoid new collisions, and any test matching base
  words is relaxed to match stable moh phrasing instead.
- Future base-prompt edits follow the same route: a corpus-derived rule,
  compressed, ADR-recorded, with prompt-matching tests checked in the
  same PR.
