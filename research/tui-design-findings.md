# TUI Design Findings — for moh's P0 TUI

Survey of beloved terminal UIs, distilled into design rules for moh. Sources: primary docs/READMEs/design postmortems of the apps below (knowledge-based survey, 2026; URLs given for reference).

## Per-app breakdown — what to steal, what to avoid

### pi coding agent (TUI reference standard)
- **Steal**: single-column conversation layout; heavy use of dim gray for all chrome (timestamps, tool args); one accent color for user turns; tool calls rendered as collapsible one-liners ("read src/x.ts L1-80 ✓ 1.2s"); input box is the only bordered element at rest; `ctrl+e` $EDITOR escape hatch.
- **Avoid**: none — pi is the closest ancestor of moh's chat surface.
- Ref: https://github.com/badlogic/pi-mono

### Claude Code
- **Steal**: permission prompts as inline boxed dialogs (not full-screen), always with a highlighted yes + dim alternatives; "always allow" writes a visible rule; spinner line with verb rotation ("Reading… / Thinking…"); esc-to-steer then a persistent "steering" hint while streaming; ctrl+t/two-esc to interrupt; queueing indicator when user types mid-stream.
- **Avoid**: walls of tool-call JSON in default verbosity (it has verbose mode for that); diff viewer can overwhelm — moh should gate diffs behind a preview key.
- Ref: https://docs.anthropic.com/en/docs/claude-code

### Codex CLI / gemini-cli
- **Steal**: from Codex — ultra-minimal default: almost no chrome until something happens; status lives in a single bottom line. From gemini-cli — the "about this session" collapsed block (model, account) that expands on demand.
- **Avoid**: gemini-cli's banner art and dense header (noise on every launch).
- Ref: https://github.com/openai/codex, https://github.com/google-gemini/gemini-cli

### lazygit
- **Steal**: THE keybinding model — a context-sensitive bottom bar of the 4-6 keys that work *right now* (changes per panel); color discipline (one accent red/green/blue, everything else gray); panels breathe; the "everything is one keystroke, listed on screen" discoverability.
- **Avoid**: its multi-panel split is for *navigation* apps; moh's chat is single-focus.
- Ref: https://github.com/jesseduffield/lazygit

### k9s
- **Steal**: progressive disclosure — a colon (`:`) command mode for the long tail, keys for the common 90%; dense info but strictly column-aligned tables; status flash messages (transient toasts at the bottom).
- **Avoid**: default density is expert-only; moh's vibe mode is the opposite pole.
- Ref: https://github.com/derailed/k9s

### btop
- **Steal**: box-drawing craft — thin/round borders as *grouping*, not decoration; block characters for progress; unified margins so every panel aligns to the same grid.
- **Avoid**: rainbow palette (pretty for sysmon, exhausting in a conversation UI).
- Ref: https://github.com/aristocratos/btop

### atuin / fzf
- **Steal**: from fzf — the query-first experience: one input, results filter live, everything else hidden (moh's Home C variant); preview pane on demand rather than always-on. From atuin — searchable history as a first-class surface (moh: session resume list as a filterable list).
- Ref: https://github.com/junegunn/fzf, https://github.com/atuinsh/atuin

### gh dash
- **Steal**: list rows that carry at most 3 data points, secondary data in dim on the same line, never stacked; section headers in dim caps with a rule line.
- Ref: https://github.com/dlvhdr/gh-dash

## Dual-mode / progressive disclosure precedents

- **lazygit vs. tig**: same domain, wildly different density — proves the audience split is real. moh's two modes map to this.
- **kubectl vs k9s**: the "expert mode is a *view*, not a different app" principle — same data, different presentation. moh: both modes are views over the same event log (already true of the architecture, #7).
- **Claude Code's verbosity setting**: `--verbose` as a runtime toggle, not a fork of the UI. moh: mode toggle live in-session (v / settings panel), persisted in config.
- **iOS/vedic principle echoed in TUIs**: novice mode should never *block* expert behavior — keys still work, they're just not advertised.

## Distilled rules for moh's TUI

1. **One column of conversation.** No side panels during chat, ever (pi, Codex). Everything else is an overlay or the footer.
2. **Two colors of text, one accent.** Body text default; *everything else* (chrome, timestamps, hints, secondary data) dim gray; a single accent (blue) for the user and interactive affordances (lazygit, gh dash). Green/amber/purple only for semantic state (ok/warn/special), max one use per screen.
3. **Whitespace over borders.** Separate blocks with a blank line first; use a border only for the input box and modal overlays (btop's borders-as-grouping, pi's input box).
4. **Context-sensitive footer.** One bottom line listing 3-5 keys valid *now* (lazygit). It changes with mode/screen; vibe mode shows even fewer.
5. **Tool calls are one line.** `tool · read src/x.ts ✓` with dim args and duration; full output opens on demand behind a key (Claude Code's collapsed tool lines).
6. **Permissions are a small centered dialog**, question first in plain language, highlighted affirmative, dim alternatives, and in dev mode the exact command + matcher (Claude Code).
7. **Vibe mode speaks human, hides all metrics.** No tokens, models, matchers, file paths as identity; session names are auto-summarized human titles ("fix the login") (kubectl-vs-k9s: same data, different view).
8. **Dev mode is vibe mode + a status line.** The only structural difference: one dense line (model · tok · cost · mode) under the header; plus verbose tool detail on demand (Claude Code --verbose).
9. **Streaming is quiet.** A dim animated indicator + verb, never a full status panel; esc-to-steer hint appears only during streaming (pi, Claude Code).
10. **Home = filter-first.** One prompt, recent sessions as dim suggestions, live-filtering resume list; dashboards with panels are dev-mode optional (fzf, atuin).
11. **Toast, don't block.** Non-critical notices (config written, memory updated) are transient one-line toasts above the footer (k9s).
12. **Consistent grid.** All overlays share the same width class and padding; aligned columns everywhere (btop, gh dash).
