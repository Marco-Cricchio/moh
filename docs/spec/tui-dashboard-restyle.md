# Spec: TUI dashboard restyle

Status: superseded by issue #183 (native scrollback session layout) · Origin: owner-inspired restyle (Juniarto Samsudin's Ink dashboard article), prototyped in `prototype/tui-dashboard.tsx`, `prototype/tui-real-session.tsx`, `prototype/tui-mockup-session.tsx` · Related: `docs/tui-style-guide.md` (to be superseded in part), viewport seam (#65), themes set

## Problem

The current TUI is a single scrolling column: conversation prints via `<Static>`, footer/input pinned below, everything else is modal overlays. The owner wants the main session screen to become a **dashboard layout** — persistent panels (menu, KPIs, activity/workflow/tokens) around a central chat — validated through three throwaway prototypes (article-faithful mockup, real-session replay, full scripted mockup session with permission interrupts, toasts, responsive fallback).

## Decisions (from grilling, all owner-confirmed)

1. **Layout: three-column dashboard ≥90 cols.** Left menu sidebar (≈20 cols), center column (KPI row + progress bar + chat), right sidebar (Activity / Workflow / Tokens, ≈30 cols). Header (logo · model · tokens · spinner) and footer chip row (keybind chips: icon + name in delicate round frames) span full width.
2. **Responsive fallback.** Below 90 columns the layout switches to **single-column**: the classic full-width chat stack + one compact status line replacing the right sidebar. Threshold lives in the viewport seam next to `COMPACT_COLS`. The switch reacts live to resize (SIGWINCH).
3. **Anchoring.** Fixed vertical budget from `rows`: header (2), panel row (bodyRows), gap (1), chips (1). Every panel box gets an explicit derived height; **only the chat content scrolls** (D4). Center column: chat box `flexGrow` within `height={bodyRows}` — no manual sibling-row arithmetic (prototype lesson: hand-counted rows drift off-by-one; let Yoga compute).
4. **Chat scroll = internal window (owner picked A).** The transcript renders inside the chat box as a fixed-height window, bottom-anchored (newest always visible). Keyboard scroll (`↑↓` / PgUp–PgDn) moves the window offset within the box; the terminal itself never scrolls during a session. A reasonable buffer of recent lines stays in memory; older history is reachable via session resume, not in-session scrollback. This replaces `<Static>` scrollback for the main screen.
5. **Chat rendering follows the prototype**: flat lines with colored speaker labels (`you` accent / `moh` purple / tool lines dim with ✓/✗, subagent lines) inside the chat box — not the labelled MsgBox stack. MsgBox survives only where boxes still make sense (modals).
6. **Modes.** `vibe` = dashboard minus the **right sidebar** (everything else identical: menu, KPIs, progress, chat, chips). `dev` = everything.
7. **Focus model.** `Tab` cycles only **menu ↔ chat input** (2 zones). When the menu has focus it owns the keyboard: `↑↓` move the `❯` selection, `⏎` activates the entry (Dashboard/Sessions/Wayfinder/Settings/Help → screen or overlay), other keys inert. When the input has focus, current keybinds apply.
8. **Overlays unchanged in shape**: modals (Settings, Commands, Permission, Frontier, Onboarding, AskUser) keep floating centered above the session via the existing OverlayLayer/Dialog pattern, restyled to the dashboard language (round borders, semantic colors, solid bg). Not anchored to panels.
9. **Toasts get a position prop.** Default: centered, bottom of the chat area. `memory`-class notifications (from the memory extractor): bottom of the **left sidebar**. Permission-granted: chat-center as today. Auto-dismiss timing unchanged (3.5s).
10. **Home stays filter-first and centered, no sidebars** — logo, search box, session list, hint — framed by the same header + chip row.
11. **Themes: 6 new entries** join the official set in `themes.ts`: `win95` (teal/silver/navy), `dos` (MS-DOS/Norton #0000AA/#55FFFF), `mac-platinum` (first **light** theme: #DDDDDD/black), `neon-noir`, `lava`, `candy`. Hex values as researched in the prototypes; each defines the full semantic token set; light theme verified for contrast on borders/dim.
12. **Migration approach: incremental refactor, not rewrite.** Reuse Chat/turns/markdown/Input/modal components and themes; replace the shell: App.tsx layout tree + viewport geometry + Chat rendering mode (window instead of Static). The style guide (`docs/tui-style-guide.md`) gets a dashboard-layout section superseding the single-column rules for the session screen.

## Invariants

1. Session behavior (events, streaming, permissions, commands, resume) is byte-identical — this is a rendering/layout change only.
2. All existing keybinds keep working when the input has focus; overlays own input while open (unchanged).
3. Terminal resize never breaks anchoring: panels stay fixed, only chat/activity windows reflow (verified pattern: explicit heights + flexGrow absorber + internal windows).
4. Existing tests stay green except where they assert single-column geometry of the session screen (updated intentionally).
5. Public package surface unchanged (no core changes; `@moh/tui` internal only).

## Delivery (to be split into tracer-bullet tickets by /to-tickets)

Indicative slicing, blockers-first:
- T1 viewport seam: dashboard/single layout classes, geometry constants (thresholds, sidebar widths, budgets)
- T2 themes: 6 new entries + light-theme token audit (independent, parallelizable)
- T3 dashboard shell: header/panels/chips layout with placeholder chat (blocks T5–T7)
- T4 focus model: tab menu↔input, menu keyboard ownership (blocks T7)
- T5 chat window: transcript-as-window with keyboard scroll, replacing Static on the session screen (the riskiest slice — needs its own tracer bullet)
- T6 right sidebar (Activity/Workflow/Tokens) with real data feeds; vibe hides it
- T7 toasts position prop + overlays restyle pass
- T8 style-guide rewrite + prototype capture on a throwaway branch (per prototype skill: main keeps only the validated decisions)

Each ticket: TDD, two-axis `/code-review` before merge, PR to `develop`.
