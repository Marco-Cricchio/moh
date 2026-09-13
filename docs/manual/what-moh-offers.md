# What moh offers

moh is a terminal coding agent designed to keep you in control while it works
inside your project. This page is a high-level guide to its user-facing
capabilities; the other manual pages explain their commands and configuration.

## Terminal coding agent

Describe a task in ordinary language. moh can inspect the project, edit files,
run commands, and report the work as it happens. In the interactive terminal
UI, you can steer a running turn with a new instruction or stop it completely.

## Interactive and headless use

Use the keyboard-driven terminal UI for day-to-day work, or use `moh run` for
scripts, automation, and CI. Headless runs never wait for an approval prompt:
an action without permission fails clearly instead.

## Provider choice and model fallback

Choose among supported AI providers, including Anthropic, OpenAI, Google,
GitHub Copilot, OpenRouter, Kimi, xAI, and compatible local or OpenAI-style
endpoints. Configure a fallback route when availability matters, so a failed
model call can move to the next model you selected rather than silently
changing vendor or model.

## Models, thinking, and usage

Switch endpoints and models without leaving the session; a switch applies to
the next turn. For models that support it, choose a thinking level from the
levels they actually expose, and optionally inspect provider-returned
reasoning. moh also records per-call and session usage and can show available
provider quota information where the provider supplies it.

## Permissions and safe execution

Every shell command and file-changing operation goes through layered rules.
You can allow, ask, or deny a whole tool or a specific command/path pattern;
moh asks when no rule decides the action. Writes outside the project are always
asked again, and extensions cannot grant access that you did not allow.

## Persistent sessions

Each conversation is a local, append-only session log. Start a new session,
resume an earlier one, rename it, search it, or fork it to explore an
alternative without altering the original history. The session tree also lets
you revisit and bookmark earlier points in a branching conversation.

## Session trash and recovery

Deleting a session moves it to a local trash rather than immediately erasing
it. You can inspect trashed sessions and restore one during its retention
period; moh refuses operations that would silently overwrite a live session.

## Handoff between machines

Move an in-progress task to another machine with a structured handoff. When
configured, moh can publish a private GitHub gist containing a synthesis and a
filtered event-log extract; file export and import remain available when that
transport is not suitable. Handoffs are opt-in and intended for serial work,
not concurrent editing of one session from two machines.

## Project memory

moh can retain durable, project-specific facts across sessions, such as local
conventions and decisions worth carrying forward. This memory is stored locally
and separately from the conversation log, so it does not turn every past detail
into a permanent fact.

## Context compaction

Long sessions can be compacted into an in-log summary that preserves task
state, decisions, and useful references while reducing the context sent to the
model. The original append-only history remains intact, and you can trigger
compaction yourself when needed.

## Session notes

Bundled workflow skills can maintain a project-scoped session note for active
work. It is a practical workspace for current plans and next steps, separate
from durable project memory and updated during the turn rather than only at
exit.

## File and directory mentions

Type `@path` to attach a file or directory to your request. moh keeps the path
in your message and creates a structured, permission-gated snapshot: file
content for files and a recursive listing for directories. Missing, denied, or
oversized mentions produce a visible warning instead of silently disappearing.

## Image mentions and previews

Image paths can be mentioned in the same way. moh passes an image to a model
only when the selected model is declared able to accept images; otherwise it
keeps a visible text reference and explains why. Terminals with supported image
protocols can show an inline preview, with a readable fallback everywhere else.

## Subagents

A task can delegate focused work to in-process subagents. They inherit only
permitted tools and cannot gain broader access than the parent session. The UI
shows active or recent subagents and can open a compact live view of their
progress while their final result remains in the main transcript.

## MCP tools

Connect Model Context Protocol servers to make external tools available to
moh. Servers can use local stdio commands or HTTP, start only when needed, and
remain subject to the same permission model. Project-defined servers ask for
trust before their first use.

## Skills

Skills are optional instruction packages that give moh specialized procedures
without loading every procedure into every task. Use bundled skills or author
your own at user or project scope; available skills appear as slash commands.

## Workflow mode

Workflow mode enables moh's first-party planning and delivery workflow while
leaving normal agent behavior unchanged when it is off. It provides skills for
work such as clarifying a design, drafting a specification, creating tickets,
implementing with tests, diagnosing a problem, and reviewing a change.

## ask-moh guidance

Use `/ask-moh` when you are unsure which skill, command, or workflow fits the
job. It routes a plain-language question to the relevant built-in guidance or
answers from the user manual rather than inventing undocumented behavior.

## GitHub and issue workflows

The optional workflow includes guided support for reporting bugs, turning an
idea into a specification or tickets, triaging work, reviewing changes, and
managing GitHub repository settings declaratively. Actions that publish or
change remote state remain visible and controlled by you.

## Moh Project Map

The optional Moh Project Map builds a local, rebuildable structural view of a
project: paths, symbols, and provable relations, never source-content copies.
moh uses it to orient eligible codebase tasks with concise, source-cited advice
and can answer a model's focused map query. Its status and diagnostics are
inspectable, while background maintenance is designed not to block a turn.

## Configuration by user and project

Configure providers, permissions, MCP servers, skills, workflow mode, memory,
handoff, image previews, and project-map behavior at the appropriate scope.
User settings provide defaults; project settings let a repository narrow or
override behavior where supported.

## Updates under your control

moh can check for new releases and bundled-skill updates while you work. It
does not install anything without explicit approval, and update checking can be
disabled.

## Extending moh

Advanced users and teams can add their own skills, custom provider endpoints,
and typed extensions. Developers can also embed the headless core in another
application. Extensions may observe the agent loop and veto tool calls, but
cannot expand the permissions you granted.

## Repository initialization

Run `moh init` to scaffold agent-oriented repository instructions and
supporting documentation. It gives a project a clear place to document its
working conventions for people and agents.
