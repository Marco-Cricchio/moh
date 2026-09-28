# ADR-0051: The deterministic compaction summarizer and the structured summary input

Status: accepted · Date: 2026-09-28 · Issue: #766 · Related: ADR-0004 (public-surface criterion), ADR-0022 (compaction), ADR-0035 (section filter)

## Context

Compaction's cut-point math is fully deterministic (`upToFor`, `turnTokens`,
`latestMarker`), but the marker's content never is: `CompactionRunner` always asked
an LLM — an in-process tool-less child session (`createCompactionSummarizer`,
#466) — to summarize the covered transcript. That costs a model call, adds latency
exactly when the session is heaviest, can fail (`compaction_failed`, sticky
warning), and produces a summary that differs between runs, resumes and machines.

Issue #766 proposed a deterministic summarization strategy behind the existing
`CompactionOptions.summarizer` seam. Triage (2026-09-20) kept the issue for its
**determinism** value — same digest across resume/fork/machines, stable tests —
after ADR-0035's section filter had absorbed the "trim without an LLM" motivation.
It flagged two decisions this ADR settles:

1. The proposed structured digest (task state, files touched, open todos) would
   have to be parsed out of the rendered transcript, or the input contract must be
   extended with structured data — a public-surface change (ADR-0004) needing an ADR.
2. Whether an over-budget digest degrades to the LLM summarizer — and how the
   degradation is made visible.

## Decision

### 1. The summarizer input gains structured facts (public surface, additive)

`CompactionSummarizerInput` gains an optional `facts?: CompactionFacts`, populated
by the runner for **every** summarizer invocation from the same covered span the
transcript renders:

```ts
interface CompactionFacts {
  turns: number;                 // whole turns covered
  userMessages: string[];        // the user's requests, in order (the task spine)
  filesRead: string[];
  filesModified: string[];       // by tool name (write-ish names), path args
  toolCalls: { tool: string; calls: number; errors: number }[];
  recentErrors: string[];        // last failed tool results, snippet-capped
  lastAssistant: string;         // tail of the last assistant text (progress)
}
```

This is an ADR-0004 reopening, deliberate and narrow: a summarizer strategy is a
client-facing seam (tests, library users, extensions may supply one), so the input
contract is public. The field is optional so existing custom summarizers keep
their signature; the transcript stays — text and facts are redundant on purpose,
because the transcript carries what facts cannot (decision wording, error context).

Facts come from the event log only, with fixed caps and no heuristics beyond the
path-argument keys (`file_path`, `path`, `filePath`, `notebook_path`) and the
write-ish tool-name test. No fact is synthesized from anywhere else.

### 2. The deterministic strategy

`createDeterministicSummarizer(fallback?, strategy?)` renders a rule-built,
byte-stable digest (`renderDeterministicDigest`): carried previous summary, task
state, files modified/read, tool traffic, recent failures, last assistant work.
Same span → same bytes, on every run and machine. No model call, no failure mode
beyond the runner's own.

### 3. The over-budget fallback is explicit, never silent

A digest larger than `DETERMINISTIC_DIGEST_BUDGET_CHARS` (16,000) would push the
rebuilt context past the point compaction exists to avoid. The run then **degrades
to the fallback summarizer** (the default LLM child session) with the same input —
never by truncating the digest, never by skipping compaction. The degradation is
recorded on the marker itself: `CompactionRunner` takes a `summarizerName` getter
and stamps the `compaction` event with `summarizer: "deterministic" |
"llm-fallback"` (audit chrome, replay ignores it; absent = the default LLM
summarizer).

### 4. Config surface

moh.json gains the JSON-safe subset:

```json
{ "compaction": { "summarizer": "llm" | "deterministic", "tailTurns": 10, "threshold": 0.8, "fallbackWindowTokens": 180000 } }
```

Default `"llm"` — today's behavior, byte for byte. `sessionFromConfig` projects it
onto `CompactionOptions.summarizerStrategy`; when `"deterministic"` is selected the
session composes `createDeterministicSummarizer(createCompactionSummarizer(...),
strategyBox)` — the LLM summarizer is always the fallback — and wires the
`summarizerName` getter. The function seams (`CompactionOptions.summarizer`,
`sectionFilter`) stay programmatic; moh.json never carries code.

### 5. Scope of the switch

Both forced paths (`/compact`, `moh compact`) go through the same runner and the
same strategy — one switch, no divergence (ADR-0022: one producer). `moh compact`
compacts closed files through `sessionFromConfig`, so it inherits the project's
config exactly as the TUI does.

## Consequences

- The common auto-compaction path can run with zero model calls when a project
  opts in; the marker content becomes reproducible, which resume/fork and tests
  can rely on.
- A deterministic digest is shallower than an LLM summary by design: it lists what
  happened, not what it meant. The explicit fallback bounds the damage; the
  `llm-fallback` stamp keeps the audit trail honest. Projects that need semantic
  summaries keep the default.
- Chained digests carry the previous summary verbatim (the one non-deterministic-
  input-free part across chained runs — it is itself a digest, so chains stay
  stable).
- The event-type change (`summarizer` on `compaction`) is chrome: replay, session
  files and clients that ignore unknown marker fields are unaffected.
- Open todos are *not* a fact source: moh has no structured todo store; inventing
  one for compaction would have widened the reopening. The user messages are the
  task spine.
