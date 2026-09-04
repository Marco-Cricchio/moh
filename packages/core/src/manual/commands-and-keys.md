# Commands & keys

Generated from the same `COMMANDS` constant the `?` panel renders —
never edit directly (`bun packages/core/scripts/gen-manual-docs.ts`
regenerates it). `?` (or `ctrl+k` in chat) opens the quick panel; this
page is the same content in manual form, plus the manual's own entries
(`ctrl+h`, `/help`).

## Chat

| Key | Action |
| --- | --- |
| enter | send |
| shift+enter | newline (option+enter / ctrl+j on legacy terminals) |
| ctrl+a/e | line start / line end |
| esc | steer (type to redirect the running turn) |
| esc esc | stop the running turn |
| ctrl+d | toggle tool-call detail |
| ctrl+o | switch vibe / dev mode |
| ctrl+t | cycle theme |
| ctrl+y | cycle thinking level |
| ctrl+s | settings panel |
| ctrl+k / ? | this command list |
| /workflow on\|off | toggle workflow mode (skills + frontier) |
| ctrl+f | frontier panel (workflow mode on) |
| @ (type it) | file mention popup: fuzzy path picker, attaches a snapshot/listing |
| q | quit (home) |

## Slash commands (type / for the completion popup)

| Key | Action |
| --- | --- |
| /ask-moh | router over moh skills + docs |
| /commands | this command list |
| /compact | force context compaction (same producer as the auto trigger) |
| /mode | switch vibe / dev mode |
| /model | model picker (or /model `<ref>`) |
| /reload | hot-reload moh.json + user config |
| /settings | settings panel |
| /theme | cycle the color theme |
| /thinking | reasoning display + thinking level |
| /wayfinder | frontier panel (workflow on) |
| /workflow | toggle workflow mode |

## Home

| Key | Action |
| --- | --- |
| type | filter sessions or start a new one |
| enter | open selection / start the typed prompt |
| n | new session |
| r / → | rename the selected session (enter confirm, empty = reset, esc cancel) |
| d | delete the selected session (y/N confirm; moves it to the trash) |
| s | settings panel |
| ? | this command list |

## Modals

| Key | Action |
| --- | --- |
| y / a / e / n | permission: yes / always / edit / no |
| esc | close panel (deny when permission asks) |

## Manual

| Key | Action |
| --- | --- |
| ctrl+h | open the user manual (chat and home) |
| /help | the user manual (slash equivalent) |
| esc | page view: back to the index (esc esc closes the manual) |
