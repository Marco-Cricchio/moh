# ADR-0029: browser tool — native headless Chromium driver

Status: accepted · Date: 2026-09-17 · Parent: issue #770 (wayfinder map), feature #769

## Context

moh's only web access is the raw `fetch` tool: it retrieves HTML/text but cannot render
JavaScript, interact with pages, or see pixels. The three use cases the owner ratified for
the browser tool — reading rendered content (SPAs), UI debugging (screenshots vs DOM),
and full automation (click/fill flows) — are all unreachable. Prior art survey and a
dependency research ticket (#771) plus a page-view prototype (#772) settled the design
inputs; the security posture was grilled with the owner (#773).

## Decision

**Go.** A native `browser` tool in the core: one tool, action-dispatched, driving a
headless Chromium via **playwright-core as an optional, lazily-imported dependency**.

Key decisions, each with its rationale:

1. **Native core tool, not MCP.** The browser is a first-class capability, not an external
   service: it rides the standard tool path (schema, `timeoutMs` resolver #300, permission
   gate, tool_result events) with zero new seams.
2. **playwright-core, optional peer; CDP-native rejected.** Stable element refs are the
   make-or-break and Playwright has solved them (in-page expando cache keyed on role+name,
   monotonic ids, stale-ref translation, shadow/slot/iframe coverage). CDP-native would
   trade ~13 MiB of bundle for owning accname computation, ref diffing, hit-target
   verification and OOPIF session management forever — under **unpinned** protocol variance
   (any user Chrome version), versus Playwright's pinned Chrome-for-Testing build.
   Chromium binaries are never bundled: user-level install on demand
   (`bunx playwright-core install chromium`, global cache). Missing toolchain → tool not
   registered with a visible diagnostic, never silent.
3. **View model: a11y-refs only.** The model's sole textual view is
   `ariaSnapshot({ mode: "ai" })` with `[ref=eN]` refs; no `get_html`, no CSS selectors
   from the model. Prototype evidence (#772): refs ~99.8% stable across DOM mutations on
   six real sites; actions resolve via the `aria-ref=eN` selector; raw HTML adds nothing
   where ai-mode works. Screenshots are first-class for the canvas blind spot (excalidraw:
   0.4 KiB of a11y content).
4. **Hard token budget + depth refinement.** Snapshots are budgeted (~20k tokens) with a
   visible truncation marker; `depth` is the refinement lever when the budget trips
   (depth prunes vertically, cost grows horizontally — the hybrid uses each where it
   works). Navigation auto re-snapshots (refs die with the document).
5. **Security posture: tiered permissions, session-scoped trust, loopback-only default.**
   Read tier allow, act tier ask (full element description in the prompt). URL-glob
   argspec (`browser:click https://app.example.com/**`) as a third ADR-0007 semantic.
   "Always for this site" is a session-scoped runtime rule, explicit opt-in only, never
   persisted. Loopback allowed by default (dev debugging is the primary use case); all
   other private/metadata ranges blocked (the prompt-injection SSRF vector). eval_js is
   honest: full page context, ask. Downloads staged, uploads root-anchored.
6. **Opt-in.** `browser.enabled` defaults to **false** — moh's zero-config posture and
   blast radius stay untouched; enabling is a deliberate act.

## Consequences

- ADR-0007 gains the URL-glob argspec semantic (amendment recorded in the spec).
- `@moh/core` exports nothing new beyond the tool's standard registration; config keys
  join `SessionConfig` per ADR-0004 (the tool is a builtin, config a documented surface).
- Missing-Playwright degradation follows the visible-diagnostic rule (like a broken MCP
  server): diagnosed, never silent, never a turn error on session start. The diagnostic
  rides a dedicated `browser_unavailable` chrome event in the event log (an explicit,
  recorded amendment to the spec's "no new chrome events" note: a visible warning in
  every surface is the point, and the log stays the one projection).
- Spec: the spec lives at `docs/spec/browser-tool.md` (local-only per repo policy —
  `docs/spec/` is gitignored planning space; the spec text is preserved in the
  wayfinder map #770's resolution trail). The ADR summarizes every normative decision;
  the implementation PRs are the source of truth for fine detail. Manual page updates
  ship with the implementation PRs.
