# moh TUI style guide

Status: current · Session layout superseded by issue #183

## 1. Session structure

The session screen is a single native-scrollback column. It never renders the former dashboard, sidebars, or a fixed-height transcript window.

1. Settled transcript blocks are emitted through Ink `<Static>` so terminal scrollback owns history and mouse selection.
2. The open turn is volatile above the input and is promoted to `<Static>` only when it settles.
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

**Vibe projection (#193).** The mode is a projection option, never a log filter. In vibe, usage/done metric blocks and non-essential chrome (session start, permission mode, skill invoked, model switched, memory updated, compaction, extension loaded, MCP started) do not render; tool activity collapses to one plain-language moh block ("read a file · src/a.ts", "ran a command") that keeps the run/ok state marker but shows no raw command line, argument dump, or output preview; failures always render as error blocks with their message. A mode switch cannot retro-edit native scrollback: each switch seals a new projection segment at the current boundary — printed blocks keep their grammar (same behavior as a theme switch), and later events follow the new one.

## 3. Input and thinking level

Separators encode the visual thinking level (real model wiring is separate):

- off/low: dim single `─`;
- medium: bold accent `═`;
- high: bold purple `═`;
- xhigh: bold animated seven-hue `═`, 120 ms phase.

Thinking labels are `·`, `🌱`, `⚙️`, `🧠✨`, `🧠🔥`. VS16 emoji may need explicit spacing because Ink and terminals disagree about cell width.

## 4. Bottom bar

The first row combines current activity and session context:

- left: spinner + phase/progress while live, otherwise ready/done and memory freshness;
- right: context bar, token count, turns, model + thinking level, workflow, git branch, and mode. In vibe mode the numbers stay hidden (no token count or turn counter — "plain language, no numbers", #193) but the wordless context bar renders in both modes (#229); the git branch (`⎇ <branch>`, filesystem-read from the session cwd, short sha when detached) and the mode chip itself always show (`○ vibe`/`◉ dev`).

Context thresholds are `ok ≤ 60%`, `warn > 60%`, `err > 80%`. Optional segments drop before wrapping; if required content still exceeds the budget, the longest segment truncates. Status rows never wrap.

The second logical row contains centered key chips (graphic round chips occupy three terminal rows) in this priority order: send, stop, model, mode, theme, commands, settings, workflow, frontier. Chips degrade graphic → compact → dropped as width shrinks; compact terminals prioritize the first four before measured dropping.

Tab/Shift+Tab cycles textarea and visible chips. Left/Right moves between chips, Enter activates, Escape returns to the textarea. Chip key labels are compact mnemonics; `^m` is activated through chip focus because terminal Ctrl+M is indistinguishable from Enter. A focused chip dims the textarea and owns ordinary key input.

## 5. Responsive geometry

- compact: `< 70` columns;
- regular: `70–109`;
- wide: `≥ 110`.

Status and chip rows must fit from 35 through 140 columns without wrapping. Transcript prose may wrap naturally inside its full-width tinted block. Ink boxes use at most `columns - 1`: exact terminal width can trigger character-by-character wrapping. Native scrollback rows retain the width at which they were printed after resize; this is expected terminal behavior.

## 6. Themes

The curated catalog is exactly: Tokyo Night, Catppuccin Mocha, Gruvbox Material, Green Phosphor, Amber Phosphor P3, Neon Noir, Lava, and Candy Pop.

Components use semantic tokens only: `fg`, `accent`, `dim`, `ok`, `warn`, `err`, `purple`, `border`, `bg`. The xhigh separator is the deliberate exception: its fixed seven-hue rainbow is theme-independent. `err` is true red and distinct from the warning semantic; it is used for failures, errors, diff removals and negative edit counts.
