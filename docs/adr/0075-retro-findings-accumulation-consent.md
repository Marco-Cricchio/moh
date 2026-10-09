# ADR-0075: Retro findings — accumulation in core, consumption at consent

Status: accepted · Date: 2026-10-09
Related: ADR-0004 (public-surface criterion), ADR-0032 (observation hooks, `appendEvent`), ADR-0049 (bounded diagnostic corpus), ADR-0056 (hook ceilings, "a non-answer is absence, never authority"), principles 5–6 (user data, prompt ownership)

## Context

An established retrospective analysis model classifies session retrospectives
into seven
analysis categories — navigation, automated checks, coding standards, steering-file
hygiene (no-ops, AGENTS.md size), tool economy, and information access — and produces
candidate improvements in order of severity. The owner asked whether moh could run this
loop natively, transparently, as a form of self-learning improvement. The stress-test
identified the load-bearing boundary: **accumulating evidence automatically is sound;
consuming it into steering or the prompt automatically is not.** Three findings drove
the decision:

1. **Findings are judgements, not facts.** Memory (the closest precedent) can append
   silently because facts are visible and correctable; a wrong improvement suggestion
   degrades every future session invisibly.
2. **Consent fatigue.** A human gate protects only while volume is bounded; 200 noisy
   findings turn "review and approve" into "approve all" — the gate becomes pro forma.
   Quality controls (dedup, confidence, caps) are therefore part of the decision, not
   an implementation detail.
3. **The no-loop rule.** A finding shown and rejected must never re-accumulate per
   session; rejecting is itself a durable user decision.

## Decision

**Split the mile: automatic accumulation, consented consumption.**

- **Accumulate (in core, automatic):** a retro-maintenance pass extracts structured
  *retro findings* — `{ category, evidence, confidence, session }` — into an append-only,
  bounded, deduplicated store under `~/.moh/projects/<slug>/retro/`, modeled on the
  ADR-0049 miss-report corpus. It never touches steering files, config, or the prompt.
- **Two extraction pipelines:** mechanical categories (missing guardrail, no-op
  instructions, tool-economy spikes) are detected by deterministic code over the event
  log — no model call; judgement categories (navigation, standards) are extracted by a
  maintenance subagent, run **on threshold** (a batch of closed sessions), not after
  every session, to keep the cost proportional to aggregate value.
- **Consume (only at consent):** findings surface as a report (`moh retro`), ordered by
  severity, proposing concrete applications (add a rule, add a check, add a navigation
  pointer). A user rejection records a durable **dismissed** state bound to the finding's
  evidence signature (category + observation fingerprint): a materially new observation —
  a new signature — is a new finding, eligible again; the report shows prior dismissals
  of the same category/subject as context; repeated dismissals raise that category's
  extraction threshold instead of re-proposing. Level-3 consumption — findings injected
  into the system prompt as a section — is explicitly rejected: it is self-modifying
  steering without consent.
- **Interaction budget (no prompt flooding):** the passive in-session surface is exactly
  one discreet count-only indicator, on the `memory_updated` model — never a message,
  never mid-turn. All interaction is pull-based: the user opens the `moh retro` report
  (or asks for it in-session, one batch). The single sanctioned proactive surface is a
  **digest** — one line at session start when new findings have accumulated since the
  last digest, pointing at the report; **rate-limited to one per 48 hours**, never per
  session, so intense vibe-coding days cannot flood. The digest is the *bridge* to the
  pull-based flow, not a substitute: it names the count and severity head, and it is
  always the same one-line shape — the report it points to stays the single place where
  findings are reviewed, dismissed or applied, and a digest shown while its report is
  already open in the same session is suppressed. No other
  notification path exists: no modal, no per-finding question, no in-stream interruption.
  Applications decided in a report session are applied in that same consented context,
  not re-asked later.

## Consequences

- The core gains one new store and one maintenance pass; the extraction logic for
  judgement categories lives with the maintenance subagent, keeping the core lean.
- Findings are user data (principle 5): project dotdir, append-only, redacted like every
  other persistence path (ADR-0058).
- The seven categories are not frozen into the core: the store schema keys on category
  strings, so the vocabulary can evolve without a format break.
- If consent fatigue is later measured as real despite the caps, the remedy is stricter
  extraction, never automatic consumption.
