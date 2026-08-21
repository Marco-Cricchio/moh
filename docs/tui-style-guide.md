# moh TUI — Style & Design Document

Status: **FROZEN (WIP)** — progress paused mid-ticket #14. This document captures every visual/layout decision made so far, so a future session resumes with full context. Companion artifacts:

- Prototype (interactive mockup): `prototype/tui-mockup.tsx` — run `bun prototype/tui-mockup.tsx`
- Live session simulator: `prototype/tui-demo.tsx` — run `bun prototype/tui-demo.tsx`
- UX research: `research/tui-design-findings.md` (12 rules), `research/tui-visual-toolkit.md` (visual stack), `research/retro-theme-palettes.md` (retro hex sources)
- Decisions context: GitHub issues #7–#13 (closed), #14 (open, this work)

## 1. Core design decisions (settled in #14, round 1)

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Root layout | Vertical stack (pi-style) + **modal overlays** for permissions/preview/wayfinder/settings. No permanent panels during chat. |
| Q2 | Multiline input | Enter sends; **shift+enter / ctrl+j** newline (kitty keyboard protocol where supported, ctrl+j fallback); **ctrl+e** opens `$EDITOR` for long text. |
| Q3 | Streaming render | Frame coalescing (~30fps) + **render window** with virtual scrollback (ctrl+u/pgup); Ink `<Static>` for settled turns. |
| Q4 | Markdown | **Full markdown** rendering (owner override over "basic subset" recommendation). Streaming-safe: auto-close unterminated fences at render time. |
| Q5 | Permission UX | **Blocking modal dialog**, full argument detail, choices y / always (shows the rule it writes) / edit / deny. Plain-language in vibe mode. |
| Q6 | Home screen | **Filter-first**: one search/new-session prompt, recent sessions filter live, `enter` resume / `n` new. Dashboards w/ panels = dev-mode optional. (Mockup variants A/B/C existed; C/filter-first won in practice.) |
| Q7 | File preview | Contextual tool-call viewer (read-only, line numbers, highlight). **always / on-demand / none — configurable** in settings. |
| Q8 | Preview persistence | Closing pop-up (esc). No persistent splits in v1. |

## 2. The two souls (owner's core directive)

Two user modes, switchable in-session (`v`) and persisted in config, settable from the settings panel (`s`):

- **vibe (simple)**: plain human language; **zero technical metrics** (no tokens, models, matchers, paths-as-identity); session titles auto-summarized ("fix the login"); labels speak ("what I did", "helpers", "The road ahead"); permission = "Quick check — may I run the tests? yes / always / no".
- **dev (developer)**: vibe mode **+ one dense status line** (model · tok · cost · permission mode) under the header; verbose tool/subagent detail on demand (`d`); technical labels ("tool · read", "subagents", matchers, log paths).

Rule: dev mode is a *view* over the same data (same event log, per #7), never a different app. Vibe mode never blocks expert behavior — keys still work, just not advertised.

## 3. Layout rules

1. **One column of conversation.** Side panels only on home (dev mode); chat is single-focus.
2. **Whitespace over borders**: blank lines separate; borders reserved for message boxes, input, modals.
3. **Rhythm scale 1-2-4**: 1 blank line within a block, 2 between speakers/boxes at rest, more between screen sections. Boxes in the transcript are **adjacent** (gap 0) — reads as one flow (owner-adjusted).
4. **Context-sensitive footer**: one dim line, 3–5 keys valid *right now*, changes per screen/mode.
5. **Streaming is quiet**: dim spinner + verb inside the moh box; "esc to steer" hint only while streaming.
6. **Toast, don't block**: transient one-line dim toasts above footer (e.g. "memory updated").
7. Input box is the only bordered element at rest; boxes use `borderStyle="round"`.
8. **Full-width responsive boxes**: message boxes, transcript column and input span `width="100%"` of the terminal; modal dialogs use percentage widths (~60%). The UI reflows on terminal resize (Ink re-renders on SIGWINCH natively). Boxes never size to content horizontally — they grow vertically only.

## 4. Chat transcript anatomy (pi-style labelled boxes)

Each turn renders as one **single-box MsgBox** (label row inside the box, no double border):

- ` you ` — accent color box.
- ` moh ` — purple box; markdown content; streaming indicator at the bottom while active; the box grows with content.
- ` tool · read ` (dev) / ` what I did ` (vibe) — dim/border-color box; **one line per tool call** (icon, file, ✓, duration); `d` expands detail (code excerpt, `┈` for elision).
- ` subagents ` (dev) / ` helpers ` (vibe) — dim box; spawn line (count · depth 1 · parallel) + one line per child (name · status · tokens); expandable result; "ask routed to you" when a child hits a permission.

## 5. Color & theming

**Semantic tokens only** — components never use raw hex. Token set: `accent, dim, ok, warn, purple, border, bg`.

Roles: `accent` = user + interactive affordances (blue family); `purple` = moh/assistant; `dim` = 60–70% of screen text (chrome, secondary data, footers); `ok/warn` = semantic state, max one use per screen; truecolor with automatic 256/16 fallback.

**Theme catalog (9, keys 1–9)**: tokyo-night (default), catppuccin, gruvbox, nord, dracula, solarized, c64, amiga, phosphor. Retro palettes are researched reproductions — sources and hex in `research/retro-theme-palettes.md` (C64 = Pepto VIC-II PAL #7869C4 on #40318D; Amiga = Workbench 1.3 #0055AA/white/#FF9900; Phosphor = P1 pure green #00FF00 on black, all-roles-green mono). Themes switchable at runtime, live everywhere (home, chat, modals), label shown in footer + settings. Future: user themes in `~/.moh/themes` (à la pi).

**Implementation lessons (must keep)**:
- Theme lives in **React state/context**, never a mutable global; a theme switch should remount or fully re-render the UI (we used `key={tick}`).
- Anything that captures colors at construction (e.g. markdown renderer) must be **theme-driven or regenerated per theme**.
- **OSC 8 hyperlinks break Ink's width calculation** → disalignment. In the prototype links are plain underline. Real app: implement own wrapping that is OSC-8-aware (links open in editor/browser where supported, plain fallback).

## 6. Typography, icons, motion

- Nerd Font glyphs (, ✓, 📖) with **capability detection + ASCII fallback**; never required. Toggle `i`.
- Fonts/sizes decided by the terminal — emphasis via bold/underline/color only. Logo: **"moh >"** bold+underline accent.
- Markdown styles, max 4 visible: bold, inline code (accent), fenced code (bordered box), links (underline). Lists: hanging indent.
- Spinner: braille dots (cli-spinners dataset), dim. Skeleton bars for long tool output.
- Diff rendering: `+` green / `-` red / context dim / hunk headers dim rules; line numbers dev-only.

## 7. Visual stack (from research)

chalk (or picocolors) · cli-highlight (inline code) · shiki lazy (preview/diff) · cli-spinners · wrap-ansi/slice-ansi (via Ink) · marked-terminal for markdown (streaming-safe wrapper) · Ink 6 (`<Static>`, focus manager).

## 8. Overlays (modals)

Shared `Dialog` shape: centered, `round` border in the overlay's semantic color, width class ~50–62, padding 2, `backgroundColor: theme.bg` for contrast over the transcript. Plain-language title first; **highlighted affirmative, dim alternatives**. Closed by esc. Known overlays: permission (warn), file preview (accent), wayfinder (purple, "The road ahead" in vibe), settings (ok), ask_user question (purple, #70).

- Permission (dev) shows exact command + matcher + tier + `y/a/e/n`; (vibe) plain ask + `yes/always/no`. If triggered by a **subagent**, label **who** is asking (planned: "for research-tui" tag).
- Wayfinder panel: next frontier ticket (friendly name in vibe), blocked count, esc close, dev: open on GitHub.

## 9. Live demo state machine (prototype/tui-demo.tsx)

Phases: `idle → typing (char-by-char) → thinking → tool? → subs? → perm? (auto-yes) → streaming (word-wise) → done → transcript`. 3-turn script, infinite loop. Keys: space pause · v mode · 1-9 theme · i icons · q quit. Debugging note: React "same key" warnings under **non-TTY** Ink are false positives (raw-mode error path) — always test under a real pty (`script -q`).

## 10. UX decisions (round 2 — settled)

| # | Decision | Choice |
|---|----------|--------|
| Q9 | Steering mid-stream | esc ×1 = steer (typed text joins current turn), esc ×2 = stop turn entirely ("esc again to stop" hint). Claude Code pattern. |
| Q10 | Provider onboarding | Hybrid: auto-detect existing env vars (ANTHROPIC_API_KEY etc.) → one-confirm "use it?"; full wizard (pick provider → masked key → connection test → default model) only if nothing detected. |
| Q11 | Telemetry opt-in | Settings panel only, never actively asked. |
| Q12 | Narrow terminals | Below ~60 cols: compact mode — minimal footer (essential keys only), inline labels, full-width dialogs. |
| Q13 | Keybinding discovery | Context-sensitive footer + `?` opens all-commands panel. No first-run cheatsheet. |
| Q16 | In-chat keybindings (implementation, #32) | Bare letters/digits collide with typing (chat input, home search), so in-session switches use non-text keys: **ctrl+m** mode, **ctrl+t** cycles theme (footer shows the label). The style guide's earlier bare `v` / `1–9` keys were prototype-only. |
| Q17 | Bare `moh` start screen (implementation, #32) | v1 AC #3 said "resumes the project's latest session"; the home screen's filter-first resume list supersedes it — bare `moh` opens home, one enter resumes the latest session. |
| Q14 | Subagent permission attribution | Title tag "Quick check — for research-tui" + border color: warn = parent ask, purple = subagent ask. |
| Q15 | Settings panel v1 | Mode, theme, icons, file preview, answer language (auto/en/it), telemetry, $EDITOR override, default permission mode + **provider management (switch/add/remove)** in-panel. |

## 11. Frozen state (as of pause)

- `prototype/tui-mockup.tsx` — interactive: tab screens, v mode, 1-9 themes, p/f/w/s overlays, d detail, i icons, MOCK_SCREEN/MOCK_MODE env shortcuts.
- `prototype/tui-demo.tsx` — live loop, verified under pty, zero warnings.
- Superseded by `packages/tui` (#32): Ink chat core (streaming, steering, home, themes). Known follow-ups from its review: virtual scrollback navigation (ctrl+u/pgup over the 200-turn render window), mode/theme persistence in config, icon capability detection + `i` toggle wiring.
- Deps installed (dev): ink@6, react@19, marked, marked-terminal, picocolors (unused yet), in package.json.
- Not yet committed (prototype lives on throwaway branch per wayfinder rules at ticket resolution).
