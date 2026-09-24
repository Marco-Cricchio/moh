# moh TUI style guide

Status: current · Session layout superseded by issue #183

## 1. Session structure

The session screen is a single native-scrollback column. It never renders the former dashboard, sidebars, or a fixed-height transcript window.

1. Settled transcript blocks are emitted through Ink `<Static>` so terminal scrollback owns history and mouse selection.
2. The open turn is volatile above the input and is promoted to `<Static>` only when it settles — with one deliberate exception (#329): while a provider reasoning block streams, everything except the last few lines (`REASONING_TAIL_LINES`) is promoted into `<Static>` incrementally as immutable continuation chunks, pi-style, so the volatile region ink fully rewrites each frame stays tiny. The settled, model-labelled block deduplicates the promoted lines when it seals, so the text lands in scrollback exactly once.
3. Transcript content has no frame glyphs. Input has no side borders; full-width horizontal separators delimit it.
4. Home and dialogs may still use `MEASURE` and framed chrome. Dialogs are blocking interaction surfaces, so round borders are appropriate there.
5. Theme switches remount the session tree; already printed scrollback remains above the new tree.
6. Modal layers are transparent outside the dialog and centered against the full terminal viewport. They render in the terminal's alternate buffer so opening them cannot move or mutate native scrollback; closing restores the main buffer. Settled history is replayed only in the alternate buffer to preserve the session behind the dialog. Only the dialog surface uses `bg` for readability.

## 2. Transcript block grammar

Every event projection is a block:

```text
glyph type detail
  body

```

The head starts at column one, body content is indented by two additional cells, and a blank row separates blocks. A full-width `Box` (`terminal width - 1`) provides a low-intensity semantic tint; padding spaces are visual only and do not add frame characters to copied text.

Semantic forms:

- `› you`: user message, warning tint.
- `◆ moh`: assistant prose, accent tint.
- `⌨ code` / `± diff`: code and diffs, purple tint; additions use `ok`, removals use `err`.
- `◌/✓/✗ tool`: running/success/failure with output.
- `⌨ preview`: numbered file output.
- permission, ask-user, error, cancelled, subagent, usage and chrome events use their dedicated head glyphs.
- `⋯ thinking`: italic dim text without a background (reserved for thinking events).

The event log remains the source of truth. Projection may group adjacent deltas or pair tool calls/results, but it must not silently discard an `AgentEvent` type.

**Vibe projection (#193).** The mode is a projection option, never a log filter. In vibe, usage/done metric blocks and non-essential chrome (session start, permission mode, skill invoked, model switched, memory updated, compaction, extension loaded, MCP started) do not render; tool activity collapses to one plain-language moh block ("read a file · src/a.ts", "ran a command") that keeps the run/ok state marker but shows no raw command line, argument dump, or output preview; failures always render as error blocks with their message. A mode switch cannot retro-edit native scrollback: each switch seals a new projection segment at the current boundary — printed blocks keep their grammar (same behavior as a theme switch), and later events follow the new one. Exception: the todo tool's box renders its full task list in both modes — the task list reads as a persistent panel, not a capped log.

**Liveness (prototype alive-proto, variant C; scanner per ADR-0042).** The volatile region stays visibly alive between stream events: running-block heads cycle animated glyph frames (`◔ ◑ ◕ ●`) on an independent ~120ms clock gated on the active turn (never on stream events, so the beat survives event gaps), and a running tool's partial output streams as a dim scrolling tail (last `TOOL_TAIL_CAP` = 9 lines) inside its volatile block via the ephemeral `tool_progress` live channel — never persisted; the settled block keeps its usual result cap, so scrollback determinism (#194) is untouched. No blinking cursor, no fake progress.

**The bottom bar's liveness scanner (ADR-0042).** Row 1's left slot is a seven-cell scanner sweep while a turn is live: one lit segment walking left→right and back (ping-pong, one cell per tick, no wrap — a full round trip is ~1.1s on the existing ~90ms clock, gated on the active turn and on input not being blocked), two cells of decaying trail behind it, and the unlit track visible the whole time. The intensity lives in the glyph (`▮` light, `▯`/`▫` trail, `·` track; ASCII `# = - .` when icons are off), so the beat reads in a monochrome terminal; the bar adds `err` on the light and the trail and `dim` on the track. It encodes exactly one bit — the turn is live — and never where the turn is going: no fill, no monotonic advance, no progress. Compact terminals keep the strip and drop the phase word, as before. The tick still produces a plain string on the `spinner` prop (a caller passing the older braille frame renders it unchanged), and the transcript's block-head animation, the `moh update` progress line and the quota modal keep their own glyphs.

## 3. Input and thinking level

Separators encode the visual thinking level (real model wiring is separate):

- off/low: dim single `─`;
- medium: bold accent `═`;
- high: bold purple `═`;
- xhigh: bold animated seven-hue `═`, 120 ms phase.

Thinking labels are `·`, `🌱`, `⚙️`, `🧠✨`, `🧠🔥`. VS16 emoji may need explicit spacing because Ink and terminals disagree about cell width.

## 4. Bottom bar

The status area is two logical rows (2A layout):

- **Row 1 — session state**: left the liveness scanner + phase/progress while live (ADR-0042), otherwise ready/done and memory freshness, then the chips the session publishes — memory freshness, the MPM map status, one per ADR-0032 extension status, and the Jev chip (below); right context bar, token count, turns, model + thinking level, workflow flag. In vibe mode the numbers stay hidden (no token count or turn counter — "plain language, no numbers", #193) but the wordless context bar renders in both modes (#229).
- **Row 2 — where you are**: the permission-mode lead on the left (below), then the right-aligned tail — cwd (`▣ <path>`), git branch (`⎇ <branch>`, filesystem-read from the session cwd, short sha when detached), the projection chip (`○ vibe`/`◉ dev`), in that order. The cwd is middle-elided to a width-class budget (18/30/44) so the head and — above all — the tail (the project directory) stay readable; the branch truncates only in the rare overflow left over. The tail is right-aligned in every combination: its justification follows the left slot, so an empty left slot (no mode to show, no notice) is simply empty.

The **permission mode** (#876) speaks in the row's left slot — the one the `⚠ YOLO` banner has always used — for all three values of `SessionMode` (ADR-0040: the mode is runtime-mutable — shift+tab rotates `normal → auto-accept → yolo → normal`). It is a statement about the session, not a property of where you are, so it never sits beside the projection chip. Copy is capitalized to stand apart from the rest of the bar, one semantic token each, and the text is the first thing the width class takes away:

- `◌ Normal` — `dim`; compact: `◌`;
- `◐ Auto-Accept` — `warn` (it grants every prompt without asking); compact: `◐`;
- `⚠ YOLO — unrestricted tools` — `err`, the true-red alarm; regular: `⚠ YOLO`; compact: `⚠`.

The glyphs stay distinguishable from the ones already in use (`▣ ⎇ ◉ ○ ◍ ✓ ∅ ↻ ⚠`). The lead is never dropped: it reserves its space first and the cwd absorbs the pressure, keeping its head and its elision marker. An active update notice follows the lead in the same slot (`⚠ YOLO · notice`), eliding as before.

The Jev chip (#876) sits in row 1's left cluster right after the memory, MPM and extension-status chips — the three alarm chips (compaction failure, external growth, browser toolchain missing) still close the cluster, so an alarm never ends up inward of a status. The browser alarm (#936) is the one non-`err` alarm (`warn`): the optional tool is simply not registered, and the session is otherwise fine. The seven use cases are independent, so the chip can only summarize and `/jev` keeps the detail:

- `◈ jev active` — at least one use case judges this session;
- `◈ jev off` — none does, and at least one is off or paused: a choice, not a defect;
- `◈ jev inert` — none judges and none is off, every one structurally unable to act here (no pool, no roster, no project root).

Below 70 columns the chip keeps its glyph alone (`◈`). There is no chip at all when the extension is not registered, or has not answered yet — the bar makes no claim it cannot read. It is read from the extension's own snapshot on the same cheap 2s poll as the MPM and extension-status chips; the outage text (`∅ jev offline`) keeps the ADR-0032 status seam to itself, one writer per seam.

Context thresholds are `ok ≤ 60%`, `warn > 60%`, `err > 80%`. Optional segments drop before wrapping; if required content still exceeds the budget, the longest segment truncates. Status rows never wrap. Segments on the right-aligned row 2 are space-joined explicitly: ink's flex `gap` is unreliable on nested right-aligned rows (segments render glued).

The third logical row contains centered key chips (graphic round chips occupy three terminal rows) in this priority order: send, stop, model, mode, commands, settings, workflow, frontier. A sticky warning prepends its own chip while it is up — the external-growth `keep` chip, and the browser-toolchain `install` chip (#936) — so the recovery action is reachable by tab as well as by its key. The theme and thinking chips were removed: `/theme` + ctrl+t and `/thinking` + ctrl+y remain the controls. Chips degrade graphic → compact → dropped as width shrinks; compact terminals prioritize the first four before measured dropping.

Tab/Shift+Tab cycles textarea and visible chips. Left/Right moves between chips, Enter activates, Escape returns to the textarea. Chip key labels are compact mnemonics; `^m` is activated through chip focus because terminal Ctrl+M is indistinguishable from Enter. A focused chip dims the textarea and owns ordinary key input.

## 5. Responsive geometry

- compact: `< 70` columns;
- regular: `70–109`;
- wide: `≥ 110`.

Status and chip rows must fit from 35 through 140 columns without wrapping. Transcript prose may wrap naturally inside its full-width tinted block. Ink boxes use at most `columns - 1`: exact terminal width can trigger character-by-character wrapping. On a real terminal resize (SIGWINCH) that changes the width, the session rebuilds (#329): screen and scrollback are cleared and the whole transcript is reprinted at the new width (debounced; height-only resizes never trigger; the scroll position resets — accepted cost, no content loss).

## 6. Themes

The curated catalog is exactly: Tokyo Night, Catppuccin Mocha, Gruvbox Material, Green Phosphor, Amber Phosphor P3, Neon Noir, Lava, and Candy Pop.

Components use semantic tokens only: `fg`, `accent`, `dim`, `ok`, `warn`, `err`, `purple`, `border`, `bg`. The xhigh separator is the deliberate exception: its fixed seven-hue rainbow is theme-independent. `err` is true red and distinct from the warning semantic; it is used for failures, errors, diff removals and negative edit counts.

### Color capability (`NO_COLOR`)

`NO_COLOR` (no-color.org) is honoured, and it is about **color only** — never glyphs, never emphasis:

- present and non-empty ⇒ no color code reaches the terminal. It says nothing about the glyph set (that is the separate `Icons` toggle): a color-free terminal keeps `▮ ▯ ▫` and its Unicode chrome.
- Bold, dim and italic are attributes, not colors: they stay. The liveness scanner therefore keeps its bold light and dim trail, and the bar keeps its `⏱`/`⚠` emphasis.
- **What a color-free session loses is the palette's hierarchy**: a `color={theme.dim}` site paints at normal intensity (there is no per-token attribute to substitute), and block tints disappear — a tint *is* color. What is left to read by is structure, glyphs and the attributes a component asks for explicitly, which is why the scanner carries its intensity in the glyph (ADR-0042).

The rule has exactly one seam (`packages/tui/src/color.ts`): `colorEnabled()` for the escapes written by hand where a string is built outside Ink (the markdown renderer, the quota modal's table cells, the preview box), and the palette projection `paintable()`/`useTheme()` for everything painted through Ink — a projected palette hands Ink `undefined` for every color token, and Ink emits nothing for a color it isn't given. `Theme` stays the honest palette (a color per role) for the math: contrast, hex parsing and the theme studio all run on real values.

Two consequences that are part of the rule rather than exceptions to it:

- **A list cursor is inverse video when there is no color.** The selection idiom is a fill (`bg` on `accent`, `dim` for the "free text" row); with both tokens gone the cursor would be unfindable, so `selectionStyle()` swaps the fill for `inverse` (SGR 7). A surface whose selection is already carried by a glyph (Home's `▸` prefix) needs none of this.
- **Syntax highlighting is skipped.** cli-highlight paints roles our theme map does not cover with its own 16-color theme, which no projection can reach — so a color-free run prints the code with no highlight instead of leaking a code the terminal was told not to receive.

The theme studio is the one surface that paints a palette rather than the session, and it builds its own theme instead of reading the context: it projects for its previews, drops its swatches and tints, and keeps the draft intact — what it hands to `onSave` is always real hexes, whatever the terminal does with them.
