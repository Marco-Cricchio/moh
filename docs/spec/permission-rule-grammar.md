# Spec: One permission-rule string grammar in the core

Status: agreed · Origin: codebase-health re-survey (opportunity: permission rule string format/parse split-brain) · Related: `docs/principles.md` (4), CONTEXT.md ("Permission rule — one grammar shared by moh.json, TUI, and CLI"), ADR-0007 (to be written with this work)

## Problem

The glossary promises "one grammar shared by moh.json, TUI, and CLI". The core delivers half: matching/segmentation (`splitCommandSegments`) is unified, but the *string* form of rules is split-brained. The CLI parses `--allow bash:git` with its own translator (`cli/src/permission-flags.ts`); the TUI hand-renders a display-only format (`bash: git → allow` in `tui/src/permission-gate.ts`) that nothing can parse back. If a rendered string ever feeds back into overrides, it silently won't parse.

## Decisions (from grilling)

1. **One official language.** The CLI's terse format (`tool:argspec`, e.g. `bash:git`) becomes the canonical writable-and-reparseable string grammar. The core exports `formatRule(rule)` / `parseRule(str)`; the CLI flag syntax is unchanged (same strings, new translator underneath). Any friendlier TUI presentation is built *on top of* the canonical form — a second language must not be invented.
2. **The translator lives in `permissions.ts`** (core). `cli/src/permission-flags.ts` moves into it: the CLI stops re-implementing grammar and imports from the core; the file disappears (or becomes a thin flag→core-adapter if a seam is genuinely needed).
3. **CLI compatibility.** `moh run --allow bash:git` and friends behave byte-identically; only the machinery underneath moves.
4. **Round-trip tests.** Core tests assert `parseRule(formatRule(rule))` deep-equals the original rule across a representative corpus (bash prefixes, path globs, bare tools, effects). This is the test that keeps an unreadable handwriting from ever being reborn.
5. **ADR-0007** records the canonical grammar (with its exact syntax) and its home; CONTEXT.md glossary entry updated to say the grammar is real (format/parse in core) and describe the syntax.

## Invariants

1. **Behavior identical** everywhere: same rules accepted from flags, moh.json, and runtime events; same events emitted; all tests green.
2. After landing: `formatRule`/`parseRule` (or equally named) are the only rule-string encoder/decoder in the repo; no client hand-builds rule strings.
3. Public surface: the new core exports are justified per the ADR-0004 criterion (TUI and CLI consume them).

## Delivery

One ticket, one PR to `develop`: `formatRule`/`parseRule` in `permissions.ts`, `permission-flags.ts` folded in, TUI renders via `formatRule`, round-trip tests, ADR-0007, glossary update. Two-axis review before merge.
