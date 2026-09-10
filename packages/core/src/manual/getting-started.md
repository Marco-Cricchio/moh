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

It asks whether you have an API key or a provider subscription (Claude
Pro/Max, ChatGPT Plus/Pro, a personal Google account) and walks you
through the rest. Subscription logins use your plan's OAuth flow — no
key to copy, and your plan's usage is what gets billed.

## Your first session

Type a prompt at the prompt and press enter. moh plans, edits files and
runs commands in your project, asking before anything sensitive. During
a running turn:

- Type to **steer**: your text interrupts and redirects the agent.
- `esc esc` stops the turn outright.
- `?` shows every keybinding; the footer always shows what is available.

## Where your data lives

moh keeps everything user-side:

- Session logs: `~/.moh/projects/<project-slug>/<id>.jsonl` — one
  append-only event log per session.
- Memory (facts kept across sessions): `~/.moh/projects/<slug>/memory/`.
- User configuration and auth tokens: `~/.moh/config`.

For a Git project with an `origin`, `<project-slug>` is the canonical
lowercase remote name (`host/owner/repo`), rather than the checkout path.
SSH and HTTPS clones of the same remote therefore use the same moh data
on a machine. Projects without a usable `origin` keep a local UUID in
`.moh/project.json` to identify their data.

After upgrading, a project that already has UUID-identified data and now
has an `origin` moves that data once to the remote-derived directory. If
that destination already contains data, moh keeps the remote-derived
version and leaves the old UUID directory untouched; it never merges two
project directories. This migration does not upload anything.

This identity migration does not upload anything. Optional features such as
an explicitly configured handoff can publish the data they describe.

## Reading further

The manual has a page per topic: sessions (new/resume/fork), providers
and models, permissions, MCP, skills and workflow mode, memory and
compaction, plus generated reference pages for the commands, the CLI and
the config schema. Press `ctrl+h` (or run `/help`) anywhere in the TUI,
or `moh manual <page-id>` from the shell. If reading is not your style,
`/ask-moh <question>` routes your question over the same manual.
