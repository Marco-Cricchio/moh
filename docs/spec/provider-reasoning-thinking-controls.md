# Spec: Provider reasoning stream and thinking controls

Status: agreed · Origin: owner grilling · Related: `docs/principles.md` (1, 2, 3, 5), ADR-0002, `docs/spec/v1.md`

## Problem

moh currently discards provider reasoning stream parts and cannot ask a model for a chosen reasoning effort. Catalog metadata records whether a model reasons but drops its level map. Users cannot inspect provider-exposed reasoning, choose a supported thinking level, or reliably resume the exact completed provider context that may include reasoning signatures.

## Decisions

1. **Provider reasoning, not private CoT.** moh handles only reasoning explicitly returned by a provider. It neither synthesizes nor claims access to a model's private chain of thought.
2. **Provider-neutral core contract.** `Provider`/`StreamEvent` gain optional, provider-neutral reasoning stream parts and a neutral thinking-level request option. Custom providers can implement them; SDK and wire-specific representations remain adapter internals.
3. **The event log retains completed reasoning.** Completed reasoning and opaque continuation artifacts are `AgentEvent` data and are persisted with the session. They participate in resume, fork, normal context reconstruction, and the recent compaction tail. This preserves Principle 2 rather than creating a transient side channel.
4. **Interrupted calls are not checkpointed.** A stream that ends before its provider message is finalized is recorded as interrupted/cancelled. Resume starts from the last completed call; no partial reasoning is replayed as a valid assistant message.
5. **Compaction remains lossy.** Old reasoning remains in the integral JSONL, but compaction may replace it in the provider prompt with its normal summary. Recent retained messages keep reasoning and continuation artifacts where required.
6. **Display is separate from persistence.** The TUI renders reasoning only when the user enables it. Its persistent default is a global user preference; `/thinking show|hide` supplies a temporary session override with immediate visual effect. Re-enabling display exposes historical completed reasoning from the loaded log.
7. **Reasoning presentation.** Each provider call has a separate `⋯ thinking · <model>` block. Failed calls retain their reasoning block with an error state. The TUI retains these blocks for the life of its running instance. Rendering is tail-capped and keeps at most 64 KiB per call, visibly marking truncation; this cap never truncates persisted data.
8. **Thinking levels.** The canonical levels are `off`, `low`, `medium`, `high`, `xhigh`, and `max`. A level persists immediately as a user preference keyed by endpoint in `~/.moh/config`, never by rewriting project `moh.json`. A new endpoint defaults to `medium` when supported, otherwise to provider default. Models show canonical levels but disable and explain unsupported entries; moh never silently maps one requested level to another.
9. **Effective-call audit.** Each `model_call` records the effective thinking level actually sent, if any. This accounts for model switches, fallback routes, and provider defaults.
10. **Capabilities.** Reasoning display works for every provider that emits reasoning. Level selection is offered only where the active model declares a supported level map.
11. **Continuation artifacts.** The Core keeps provider-required opaque artifacts in memory while a turn runs and persists them only once the corresponding provider message completes. They are never rendered as reasoning text.
12. **Informed consent.** Before the first compatible call, the TUI gives a one-shot, non-blocking notice that provider-exposed reasoning and continuity metadata are saved in the session for resume. Session export/backup therefore includes them.

## Invariants

1. Core owns all provider calls and adapter translation; TUI and CLI never call providers directly.
2. All persisted reasoning is represented in the append-only event log; no client-only stream bypasses the log.
3. A completed session replay produces the same provider message context, including reasoning and opaque artifacts, until normal compaction semantics take effect.
4. Turning display on or off never changes a provider request, persisted data, model context, or permission behavior.
5. Provider-specific reasoning protocol data never leaks into the public neutral API except as opaque continuation metadata.
6. Existing models/providers without reasoning or level support remain functional and do not receive unsupported request fields.

## Delivery

Split into tracer-bullet tickets with explicit dependencies:

1. Core neutral types, event-log schema/replay, provider request options, and adapter stream translation.
2. Catalog/config and endpoint preference persistence.
3. TUI reasoning projection, display controls, historical replay, consent notice, and thinking-level picker/chrome.
4. Cross-layer integration, resume/compaction/fallback coverage, documentation, and two-axis review.

Every ticket uses TDD and targets `develop`.
