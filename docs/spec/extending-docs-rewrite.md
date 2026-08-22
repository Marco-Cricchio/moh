# Spec: Rewrite docs/extending for the stable surface

Status: agreed · Origin: codebase-health campaign (final queue item) · Related: `docs/principles.md` (1, 4, 6, 7), ADR-0004 (surface criterion), ADR-0005 (sessionFromConfig), ADR-0007 (rule grammar)

## Problem

`docs/extending/` is four thin files (~133 lines: index 9, api-reference 68, pi-compatibility 16, skills 40) that predate the session/ decomposition, memory (#38), subagents (#13), workflow mode (#36), the curated public surface (ADR-0004), sessionFromConfig (ADR-0005), and the permission rule grammar (ADR-0007). The campaign deliberately deferred docs until the surface was stable; it now is.

## Decisions (from grilling)

1. **Two reader personas, separate sections:**
   - **Extension writers** — the `@moh/extension` contract: phase hooks and their ordering, veto semantics (restrict-only), event observation, lifecycle, failure behavior.
   - **Library users** — embedding moh: `sessionFromConfig`, the event log as the session (consume the `events` async iterable), headless permission seams.
2. **Working examples over signature lists:** a commented minimal extension that actually runs; a library usage walkthrough with `sessionFromConfig`; hook ordering documented explicitly; the ADR-0007 rule grammar (`formatRule`/`parseRule` syntax) documented where users meet it. Existing files (api-reference, pi-compatibility, skills) are rewritten or folded into the new structure rather than kept as-is.
3. **Light alignment rule, recorded:** a PR that changes a public door updates the affected chapter in the same PR. Recorded in the ADR/glossary notes; no automation for now (can be evaluated later).
4. **Scope contained:** `docs/extending/` only, plus a link from the README's docs section. CONTEXT.md, ADRs, README stay as they are (a README pass is a possible later campaign item).
5. **Delivery:** one ticket, one PR. Because this is prose, the owner reviews an Italian draft for sense before the English final merges. All artifacts in English (principle 7); two-axis review adapted (spec-axis = do the examples actually run).

## Invariants

1. Every code example in the docs compiles/runs against the current develop (the implementer verifies each against the real packages).
2. No new public API promises: docs describe what exists, per the ADR-0004 keep-list.
3. The two personas never share a chapter; each chapter opens with who it's for.

## Delivery

One ticket, one PR to `develop`: rewritten `docs/extending/` (proposed files: index, extensions, library-usage, plus rewritten skills/api-reference content folded in), README link, glossary note on the personas + alignment rule, Italian draft reviewed by owner before merge.
