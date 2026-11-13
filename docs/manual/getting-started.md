# Getting started

moh is a coding agent that lives in your terminal. One command starts it:

```
moh
```

The first run needs nothing: no accounts, no API keys, no configuration.
moh opens with the **mock** provider so you can look around immediately;
when you are ready to use a real model, run the guided onboarding:

```
moh provider add
```

It offers an API key or, for supported providers, a subscription login
(Anthropic, ChatGPT, GitHub Copilot, OpenRouter, xAI, Kimi). Review the
provider-specific terms before authorizing: a successful OAuth login does
not guarantee inference access, included plan usage, or API data protections.

**Anthropic subscription login is available again, conditionally.** Anthropic
may allow certain third-party tools for paid subscribers with usage credits
enabled, and may charge those credits instead of subscription limits. Its
Claude Code documentation still restricts third-party Claude.ai login and
credential intermediation. moh is an independent client, and the login flow
does not establish Anthropic approval. API-key access remains recommended.
See [Providers & models](./providers-and-models.md) for the source links.

**Google remains API-key only in onboarding** because its personal Code
Assist credentials do not support moh's inference transport. Existing Google
subscription endpoints receive a startup warning; `moh provider logout <name>`
drops their tokens.

## Your first session

Type a prompt at the prompt and press enter. moh plans, edits files and
runs commands in your project, asking before anything sensitive. During
a running turn:

- Type to **steer**: your text interrupts and redirects the agent.
- `esc esc` stops the turn outright.
- `?` shows every keybinding; the footer always shows what is available.
- Below 70 columns the footer degrades in tiers instead of wrapping: the
  context gauge becomes `[xx%]`, the model drops its `endpoint/` prefix then
  elides then disappears (ctrl+m / `/model` still reach it), and on the
  where-you-are row the branch drops whole before truncating and the cwd
  collapses to its tail (`…/moh`) before dropping. The mode glyph and the
  projection chip survive at every width.
- The footer's last row is standing identity, not status: the running moh
  version on the left (`MoH - vX.Y.Z`), the session name (only after a
  rename with ctrl+r) and the session id on the right.

In chat, `!cmd` runs a shell command and `!!cmd` also sends its output to
the model, through the usual permission rules. To send a prompt beginning
with a literal `!`, type `\!` instead: the escape backslash is consumed
before the prompt reaches the model.

## Where your data lives

moh keeps everything user-side:

- Session logs: `~/.moh/projects/<project-slug>/<id>.jsonl` — one
  append-only event log per session.
- Memory (facts kept across sessions): `~/.moh/projects/<slug>/memory/`.
- User configuration and auth tokens: `~/.moh/config`.
- Provider refusals moh could not read a context window from:
  `~/.moh/context-refusals.log` — a small, bounded diagnostic (one line
  per distinct wording, with a repeat count) holding nothing but the
  provider's own refusal text, as shown in
  [Memory & compaction](./memory-and-compaction.md). Delete it any time.

For a Git project with an `origin`, `<project-slug>` is the canonical
lowercase remote name (`host/owner/repo`), rather than the checkout path.
SSH and HTTPS clones of the same remote therefore use the same moh data
on a machine. Projects without a usable `origin` keep a local UUID in
`.moh/project.json` to identify their data.

When a project that already has UUID-identified data gains an `origin`, that
data moves once to the remote-derived directory — even if a second moh
process had already created the remote-derived directory as an empty shell
(e.g. the origin was added while a session was open). If that destination
already contains data of its own, moh keeps the remote-derived version,
leaves the old UUID directory untouched, and the home list shows a warning
line naming both directories so the older data stays visible; it never
merges two project directories.

This identity migration does not upload anything. Optional features such as
an explicitly configured handoff can publish the data they describe.

## Projects on Windows drives (WSL)

Under WSL your Windows drives appear under `/mnt` — `/mnt/c` is your `C:`,
`/mnt/d` your `D:`. A project kept there works, but moh warns you about it
(the footer hint in the TUI, one line from `moh run`): `/mnt/c` is not a
Linux directory, it is a mount of the Windows filesystem, so every read,
write and directory listing crosses into Windows and back. That is what
makes grep, glob and large edits crawl.

Nothing breaks — the work is just slow. Keep projects in the Linux
filesystem instead, `~/projects` for example, and the same session runs at
native speed. This is WSL-only advice: on macOS and on plain Linux there is
no `/mnt` Windows drive to avoid.

## Reading further

The manual has a page per topic: sessions (new/resume/fork), providers
and models, permissions, MCP, skills and workflow mode, memory and
compaction, plus generated reference pages for the commands, the CLI and
the config schema. Press `ctrl+h` (or run `/help`) anywhere in the TUI,
or `moh manual <page-id>` from the shell. If reading is not your style,
`/ask-moh <question>` routes your question over the same manual — and the
agent itself consults it through the `moh_docs` tool whenever you ask
about moh's own capabilities, so the answer comes from this manual, not
from memory.
