# TUI Visual Toolkit — techniques & libraries to make moh's TUI beautiful

Companion to `tui-design-findings.md` (that one = layout/UX rules; this one = visual craft: color, type, icons, markdown, motion). Stack: TypeScript + Bun + Ink. All libraries verified as npm-installable TS/JS.

## 1. Color & palette

- **picocolors** (`picocolors`, ~0 deps) or **chalk** (v5 ESM) — chalk is the ecosystem standard, richer API (bold/dim/underline composable), picocolors is the tiny choice. Either is fine; both work under Bun. https://github.com/alexeyraspopov/picocolors
- **Truecolor (24-bit) with graceful fallback.** All modern terminals (iTerm2, WezTerm, kitty, Windows Terminal, most others) support 24-bit color; libraries auto-detect via `supports-color` and fall back to 256/16. Design the palette in OKLCH or a curated palette (e.g. Tokyo Night, Catppuccin, Nord — all ship hex sets for terminal use) and let chalk downgrade automatically. https://github.com/catppuccin/catppuccin
- **Theme tokens, not raw hex, in components.** A single `theme.ts` with semantic roles (`accent`, `dim`, `ok`, `warn`, `err`, `border`, `bg`) — this is what makes a theme system (light/dark, user themes) possible later. Precedent: pi ships `docs/themes.md` — moh should copy the concept (user-selectable themes in ~/.moh/themes).
- **Dim text is the highest-leverage visual tool**: dim gray for 60-70% of the screen's text instantly creates hierarchy and "air" without any layout change (see lazygit, pi). Use true dim (`\x1b[2m`) rather than only gray hex, so it works on light backgrounds too.
- **Background tints** for selected rows / active input: subtle `bg + black text` beats inverse video; inverse is jarring.

## 2. Typography & box drawing

- **Nerd Fonts glyphs, with capability detection.** Icons (, , ✓) require a Nerd Font; use `is-nerd-font` style detection or a settings toggle + ASCII fallbacks (`>`, `[x]`). Never require them. https://www.nerdfonts.com/
- **`boxen`** (from sindresorhus) for one-off framed boxes (splash, dialogs in headless mode); in Ink, borders come from `<Box borderStyle>` — round/round+dim is the modern look (lazygit, gh dash), single/double reads retro.
- **Text wrapping discipline**: `wrap-ansi` (what Ink uses internally) — always wrap to measured terminal width minus padding; never hardcode widths. Ellipsis via `widest-line`/`slice-ansi` for one-line cells.
- **Proportional rhythm**: pick a 1-2-4 spacing scale (1 blank line within a block, 2 between speakers, 4 between screen sections) and apply it everywhere — this is the "air" the owner asked for, systematized.

## 3. Markdown rendering (user chose full markdown, Q4)

- **marked-terminal** — mature markdown→ANSI (used by many CLIs); handles code blocks, tables, lists. Can restyle via a theme object. Risk: built for batch rendering, not streaming partials. https://github.com/mikaelbr/marked-terminal
- **Streaming-safe strategy (the real technique)**: buffer per-message, re-render the *message component* (not the whole screen) on each coalesced frame (~30fps per research rule); when a code fence is unterminated, render the partial as plain indented text and switch to fenced highlight only when the fence closes — this kills the classic "half-drawn table/fence" glitch. Alternative: render markdown only on sentence/chunk boundaries (pause points), plain text in between.
- **Terminal-friendly styles**: keep at most 4 markdown styles visible — bold, inline code (accent fg or dim bg), fenced code (bordered box), links (underlined + OSC 8 hyperlink, dim URL hidden). Lists rendered with a hanging indent `  • `; headings as bold + blank line (no ASCII underline bars).

## 4. Syntax highlighting

- **cli-highlight** (highlight.js-based, sync, fast) — the standard for inline code/diffs in CLIs. https://github.com/felixfbecker/cli-highlight
- **shiki** is prettier (TextMate grammars, our exact palette themes) but async + heavy — viable since moh is a rich TUI, use it for the file-preview overlay and diffs, cli-highlight for quick one-liners. Both Bun-compatible.

## 5. Diffs & code preview

- **`diff` npm lib or jsdiff** for computing; render with gh-dash/lazygit conventions: `+` green / `-` red, context lines dim, hunk headers as dim rules, line numbers only in dev mode. https://github.com/kpdecker/jsdiff

## 6. Motion & feedback (small, tasteful)

- **cli-spinners** (JSON spinner definitions — braille dots, dots, arc) — this is the dataset behind ora; use directly in Ink for the quiet streaming indicator. https://github.com/sindresorhus/cli-spinners
- **Skeleton lines** for long tool outputs (dim `▓▓▓░░` bars) instead of nothing.
- **Enter/exit animations for overlays**: Ink `useFocus` + a 1-frame fade is enough; full animation in terminals reads gimmicky fast.
- **Progress for downloads/installs**: single line, ETA + spinner, never multi-line bars in a chat UI.

## 7. Interaction polish techniques

- **OSC 8 hyperlinks** (clickable in iTerm2/kitty/WezTerm/Windows Terminal): file paths and GitHub issue links open in editor/browser — huge perceived quality win, zero cost. Escape with a plain-URL fallback.
- **Terminal images** (sixel / `terminal-image`, iTerm2 inline) — only for vibe mode when the model describes an image; P2 curiosity, not P0.
- **Bracketed paste + kitty keyboard protocol**: detect via `node-ansi`-style capability probing; enables real shift+enter newline in more terminals (kitty/WezTerm/Ghostty) without the ctrl+j fallback. Worth a capability layer from day one: `shift+enter` where supported, else `ctrl+j`/backslash fallback — matches Q2.
- **Window title** via escape sequence (`\x1b]0;moh — session name\x07`) and **terminal bell** (opt-in) on permission ask.

## 8. Reference implementations to copy from

- **pi TUI**: markdown-in-Ink streaming, theme token file, dim chrome — closest code to read. (readable in the pi repo: packages/agent-ui)
- **gh dash (DLX/dlvhdr)**: Ink + clean borders + list craft. https://github.com/dlvhdr/gh-dash
- **viddy /ATuin**: minimal prompt surfaces.
- **Ink 6**: built-in `<Static>` for scrollback (perf with long output — pairs with our render-window rule), `useFocusManager` for overlay focus traps. https://github.com/vadimdemedes/ink

## Recommended concrete stack for moh P0

chalk (or picocolors) · cli-highlight (inline code) · shiki (preview/diff overlay, lazy) · cli-spinners · wrap-ansi/slice-ansi (via Ink) · semantic theme tokens + Tokyo Night default palette · Nerd Font glyphs w/ ASCII fallback · OSC 8 links · capability probe layer (truecolor, shift+enter, nerd font).
