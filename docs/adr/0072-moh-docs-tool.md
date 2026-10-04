# ADR-0072: The `moh_docs` built-in tool — grounded answers about moh itself

Status: accepted · Date: 2026-10-04 · Issue: #1194 · Related: ADR-0013 (the bundled user manual), ADR-0011 (turn-scoped skill prompts), ADR-0029 (tool permission tiers)

## Context

A user on the compiled binary asked the agent whether moh extensions can
contribute UI. The model answered from its trained knowledge and was
confidently wrong: it described extensions as observation/veto hooks only,
missing the apiVersion 1.11–1.12 overlay/panel/command contributions
(ADR-0062). The correct documentation ships inside the very binary the
user runs — `packages/core/src/manual.ts` bundles thirteen manual pages
exactly so the answer exists without a codebase checkout (ADR-0013) — but
nothing routes the *model* to it. The `/ask-moh` router reaches the manual
only when the user types the command, and its skill is
`disable-model-invocation`. In a plain conversation the model has no
mechanism to consult moh's own documentation, and stale trained knowledge
loses to no knowledge: a plausible wrong answer is the worst failure mode.

## Decision

moh gains one built-in read-only tool, **`moh_docs`**, plus one sentence in
the base prompt.

**The tool.** `moh_docs` serves the bundled manual pages
(`allManualPages` / `manualPage` / `manualIndex` — no new data source, no
filesystem access, nothing that can drift from the binary). Three
operations:

- `index` — the page index (id, title, summary).
- `read` — one full page by id.
- `search` — a plain keyword query over all pages; returns matching
  excerpts with their page id and title, capped, with the page names so
  the model can `read` the full page.

Citations use the format `Manual → <Title>` already defined by the
ask-moh skill. When no page covers the question, the tool result says so —
the model is instructed to answer "the manual doesn't cover this" rather
than guess.

**Permissions.** `"allow"` in `DEFAULT_TOOL_PERMISSIONS`: the tool reads
only content compiled into the binary — no paths, no network, no side
effects — and belongs with `read`/`grep`/`mpm_query` in the free tier. It
remains overridable by user rules like any built-in.

**The prompt.** One sentence in the shipped base prompt: for any question
about moh itself (capabilities, commands, config, permissions, extensions),
consult `moh_docs` first and answer from it — never from memory; if the
manual doesn't cover it, say so. This is a strong instruction, not a
mechanical guarantee: the model may still occasionally skip the tool, but
the ground truth is now one cheap call away, which converts the failure
class from "default" to "rare exception".

**Scope.** No auto-injection of manual content into every prompt (token
cost on every call for knowledge most turns never need), no
question-intent classifier (fragile heuristics on the user's turn text),
and no change to `/ask-moh` or the workflow-mode gate — the tool and the
router are complementary surfaces over the same pages.

## Consequences

- A binary-only user's agent can now answer moh-capability questions
  grounded in the shipped documentation; answers cite their page.
- The tool is client-agnostic (TUI, CLI, SDK) for free: it rides
  `builtinTools` like every other built-in.
- The manual pages remain the single source of truth; a capability added
  without a manual-page update is invisible to the tool — the existing
  light-alignment rule (manual pages in the same PR) already owns that.
- The base prompt grows by one sentence; `promptVersion` hashes shift
  (expected; the hash is informational).
- One TUI vibe verb is added for the tool's activity line.

## Considered Options

- **Auto-inject relevant manual sections** into the system prompt: pays
  the token cost on every turn and still needs "what is this turn about"
  detection — the fragile part — before injection can help.
- **A docs-consultation tool only, no prompt hint**: discoverable but not
  reliably reached; the hint is what changes the default behavior.
- **Strengthen ask-moh / memory**: a user-level skill copy can stale
  against the binary, stays behind the workflow-mode gate and manual
  invocation; treats the symptom, not the mechanism.
- **Fail loudly on meta-questions**: requires intent classification with
  silent-failure modes; makes correct answers harder instead of easy.
