# moh TUI — Style & Design Document

Status: **LIVING** — reflects the shipped dashboard TUI (`packages/tui`, issues #113–#119). The dashboard layout **supersedes** the original single-column session-screen rules; everything below describes what ships today. Companion artifacts:

- Spec: `docs/spec/tui-dashboard-restyle.md` (decisions D1–D12, owner-confirmed)
- Prototypes (throwaway, pointer on issue #120): branch `prototype/tui-dashboard-restyle`
- Earlier prototypes: `prototype/tui-mockup.tsx`, `prototype/tui-demo.tsx`
- UX research: `research/tui-design-findings.md`, `research/tui-visual-toolkit.md`, `research/retro-theme-palettes.md`

## 1. Core design decisions

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Root layout | **Dashboard frame on the session screen** (≥ 90 cols): header, panels row, gap, chip footer; modal overlays float above it. Single-column fallback below 90. |
| Q2 | Multiline input | Enter sends; **shift+enter / ctrl+j** newline (shift+enter needs the kitty keyboard protocol — enabled via `kittyKeyboard: auto` in main.tsx, negotiated on kitty/WezTerm/Ghostty; elsewhere it is a plain `\r`, indistinguishable from Enter — so ctrl+j is the universal fallback); **ctrl+e** opens `$EDITOR` for long text. Ink 6 parses ctrl+j's `\n` byte as `name:"enter", ctrl:false` — `\n` must map to newline, `\r`/`key.return` to submit. |
| Q3 | Transcript rendering | **Internal chat window** (D4): fixed-height, bottom-anchored window inside the chat box; keyboard scroll moves a window offset; the terminal never scrolls in-session. `<Static>` scrollback is gone from the session screen. |
| Q4 | Markdown | **Full markdown** rendering; streaming-safe (auto-close unterminated fences at render time). |
| Q5 | Permission UX | **Blocking modal dialog**, full argument detail, `y / always / edit / deny`; plain-language in vibe mode. |
| Q6 | Home screen | **Filter-first and centered, no sidebars** (D10): logo, search box, session list, hint — framed by the same header + chip row. |
| Q7 | File preview | Contextual tool-call viewer (read-only, line numbers, highlight). `always / on-demand / none` in settings. |
| Q8 | Preview persistence | Closing pop-up (esc). No persistent splits in v1. |

## 2. The two souls (owner's core directive)

Two user modes, switchable with **ctrl+o** and persisted in config, settable from the settings panel:

- **vibe (simple)**: plain human language; **zero technical metrics**; session titles auto-summarized; permission asks in plain language. **Vibe = dashboard minus the right sidebar** (D6): menu, chat, header, chips all stay — the center column absorbs the freed width.
- **dev (developer)**: vibe mode **+ the right sidebar** (Activity / Workflow / Tokens) and verbose detail on demand (`ctrl+d` inline tool output).

Rule: dev mode is a *view* over the same data (same event log), never a different app. Vibe mode never blocks expert behavior — keys still work, just not advertised.

## 3. Dashboard layout (session screen, supersedes single-column)

The session screen is a **dashboard frame** (`Dashboard.tsx`) at ≥ 90 columns (`DASHBOARD_COLS` in the viewport seam):

```
┌ moh > ──────────────── model · tokens ┐   header (2 rows)
│ Menu    │                        │ Act│
│ ❯ Dash… │   chat column          │ Wor│   panels row (bodyRows)
│ Sessions│   (chat window + input)│ Tok│
│ …       │                        │    │
│         │                        │    │
 ────────────────────────────────────────   gap (1 row)
  ( ⏎ send ) ( esc steer ) ( ^s settings )   chips (1 row)
```

1. **Three columns**: left menu sidebar (16 cols, 20 when wide ≥ 110), center chat column, right sidebar (24 cols, 30 when wide). Center width = terminal − sidebars − 2 gap columns; with the right sidebar hidden (vibe) the center absorbs its width.
2. **Single-column fallback < 90 cols**: the classic full-width chat stack; menu focus is disabled (`menuLive` requires the dashboard layout). The switch reacts live to resize (SIGWINCH) through the viewport seam.
3. **Anchoring** (D3): fixed vertical budget from `rows` — header (2) + panel row (`bodyRows`) + gap (1) + chips (1) + 1 fullscreen-guard row (a frame exactly as tall as the terminal trips Ink's fullscreen repaint path — always stay one row short). Every panel gets an explicit derived height; the chat column flexes within it. **Never hand-count sibling rows** (prototype lesson: off-by-one drift; let Yoga absorb the remainder). Only the chat and Activity windows scroll internally; panels never grow.
4. **Header**: logo `moh >` (bold+underline accent) left, `model · tokens` dim right, bottom border only.
5. **Footer chip row**: keybind chips — icon + name in delicate round frames `( ⏎ send )`, dim parentheses, accent icon. One row, no wrapping; chips are dropped from the right when they don't fit (`fitChips`). Bordered boxes would cost 3 rows against the 1-row budget — never.
6. **Left menu**: `Dashboard / Sessions / Wayfinder / Settings / Help`; selected entry `❯ entry` accent bold, others dim.
7. **Right sidebar** (dev only, `SidePanel.tsx`): **Activity** (recent tool calls ✓/✗/… and subagent state, internally windowed with `↑ N more`), **Workflow** (frontier: claimed/ready/blocked, refreshed each turn), **Tokens** (context usage bar `█░` against a 200k assumed window, counts). Workflow and Tokens anchor to the panel bottom; only the Activity window absorbs height changes. Pure projections from the event log (`sidebar.ts`).

Whitespace/borders on the dashboard: panels are `borderStyle="round"` in `theme.border`; blank-line rhythm (1 within a block, 2 between speakers) applies inside the chat window only — the frame itself is bordered panels, not whitespace.

## 4. Chat window (D4–D5, supersedes the MsgBox transcript stack)

The transcript renders as a **fixed-height, bottom-anchored window of flat lines** inside the chat box — not the labelled MsgBox stack (MsgBox survives only where boxes still make sense: modals):

- Speaker labels as colored lead lines: ` you` accent, ` moh` purple; tool lines dim with `✓ / ✗ / …` marks, one line per call (name + arg summary + first output line, truncated); `ctrl+d` inlines truncated tool output (≤ 15 lines) under each call.
- Streaming: dim spinner line `· streaming… · esc to steer` while active; error lines `⚠ reason: message` in warn; cancelled `· stopped ·`.
- **Scroll math** (`chat-window.tsx`): a `ScrollAnchor` (`follow` + `offset`) — follow pins to the tail (streaming lines arrive at the bottom, view tracks); scrolling up pauses follow, the visible window stays put as content grows below. Reaching the bottom resumes follow. Buffer in memory: 1000 recent lines; older history = session resume, not in-session scrollback.
- Line geometry derives from the seam (`chatWrapWidth`, `chatWindowRows` — multiline drafts shrink the window so the frame never exceeds the terminal). Window floor: 3 rows.

## 5. Focus model (D7)

`tab` cycles only **menu ↔ chat input** (2 zones). Menu-focused, the menu owns the keyboard: `↑↓` move the `❯` selection (wraps), `⏎` activates the entry (screen or overlay; focus returns to the input), every other key inert — no key leaks to the input. Input-focused, the current keybinds apply unchanged (§10 Q16). In single-column fallback the menu is inert and focus stays on the input.

## 6. Color & theming

**Semantic tokens only** — components never use raw hex. Token set: `fg, accent, dim, ok, warn, purple, border, bg`.

Roles: `fg` = default text on bg; `accent` = user + interactive affordances (blue family); `purple` = moh/assistant; `dim` = chrome, secondary data, tool lines, footers; `ok/warn` = semantic state, max one use per screen; truecolor with automatic 256/16 fallback.

**Theme catalog (15, cycled via ctrl+t / settings)**: tokyo-night (default), catppuccin, gruvbox, nord, dracula, solarized, c64, amiga, phosphor, win95, dos, mac-platinum (first **light** theme — dim/border audited for contrast on #DDDDDD), neon-noir, lava, candy. Retro palettes are researched reproductions — sources and hex in `research/retro-theme-palettes.md`. Themes switchable at runtime, live everywhere (dashboard, home, modals); label shown in footer + settings. Future: user themes in `~/.moh/themes`.

**Implementation lessons (must keep)**:
- Theme lives in **React state/context**, never a mutable global; a theme switch fully re-renders the UI (`key={tick}`).
- Anything that captures colors at construction (e.g. markdown renderer) must be theme-driven or regenerated per theme.
- OSC 8 hyperlinks break Ink's width calculation → disalignment. Links render as plain underline (OSC-8-aware wrapping is a future item).

## 7. Typography, icons, motion

- Nerd Font glyphs (, ✓, ❯) with capability detection + ASCII fallback; never required.
- Emphasis via bold/underline/color only; the terminal decides fonts/sizes.
- Markdown styles, max 4 visible: bold, inline code (accent), fenced code (bordered box), links (underline). Lists: hanging indent.
- Spinner: braille dots (cli-spinners dataset), dim.
- Diff rendering: `+` green / `-` red / context dim; line numbers dev-only.

## 8. Visual stack

chalk (or picocolors) · cli-highlight · cli-spinners · wrap-ansi/slice-ansi (via Ink) · marked-terminal (streaming-safe wrapper) · Ink 6.

## 9. Overlays & toasts

**Modals** (Settings, Commands, Permission, Frontier, Onboarding, AskUser): shared `Dialog` shape — centered against the full viewport (both axes), floating **above the dashboard** (transparent backdrop; the dialog's own `backgroundColor: theme.bg` provides contrast), `round` border in the overlay's semantic color, viewport-derived width (`dialogWidth` ~62% clamped [40, 100], full width when compact), padding 2, restyled to the dashboard language (D8). Not anchored to panels. Plain-language title first; highlighted affirmative, dim alternatives. Closed by esc. Height-aware (#64): menus window around the cursor (`windowing`) with `↑/↓ N more`. The overlay layer stays one row short of fullscreen (Ink repaint guard).

- Permission (dev): exact command + matcher + tier + `y/a/e/n`; (vibe) plain ask + `yes/always/no`. Subagent-triggered asks are tagged **who** is asking ("for research-tui"), border color warn = parent / purple = subagent.

**Toasts** (D9) get a `position` prop: default **chat** = centered at the bottom of the chat column; **side** = bottom of the **left menu sidebar**, wrapped to its width — used for `memory`-class notifications. Permission-granted notices land chat-center. Toasts float in an absolute layer above the panels — they never shift layout. Auto-dismiss 3.5s, max 3 stacked.

## 10. UX decisions (settled)

| # | Decision | Choice |
|---|----------|--------|
| Q9 | Steering mid-stream | esc ×1 = steer (typed text joins current turn), esc ×2 = stop turn ("esc again to stop" hint). |
| Q10 | Provider onboarding | Hybrid: auto-detect env vars → one-confirm; full wizard only if nothing detected. |
| Q11 | Telemetry opt-in | Settings panel only, never actively asked. |
| Q12 | Narrow terminals | Compact mode below 60 cols: minimal footer, inline labels, full-width dialogs. Single-column session fallback below 90 (§3.2). |
| Q13 | Keybinding discovery | Context-sensitive chip footer + ctrl+k all-commands panel (menu entry Help opens it). No first-run cheatsheet. |
| Q16 | In-chat keybindings | Non-text keys only: **ctrl+o** mode, **ctrl+t** theme, **ctrl+d** tool detail. Bare `v`/`1–9` were prototype-only. ctrl+m is unusable: terminals send `\r` (0x0D) for both Enter and ctrl+m, so the two are indistinguishable. |
| Q17 | Bare `moh` start | Opens home (filter-first); one enter resumes the latest session. |
| Q14 | Subagent permission attribution | Title tag + border color (§9). |
| Q15 | Settings panel v1 | Mode, theme, icons, file preview, answer language, telemetry, $EDITOR, default permission mode + provider management. |

## 11. History

- `prototype/tui-mockup.tsx`, `prototype/tui-demo.tsx` — original single-column prototypes (issues #7–#14).
- `prototype/tui-dashboard-restyle` branch — the three dashboard prototypes (tui-dashboard, tui-real-session, tui-mockup-session); pointer comment on issue #120. Main keeps only the validated decisions (spec + this guide).
- Dashboard shipped in #113–#119 (T1–T7); this guide rewritten in #120 (T8).
