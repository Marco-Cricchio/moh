# ADR-0011: Skill prompts ride the system prompt, not the user message

- Status: accepted
- Date: 2026-08-25

## Context

`/ask-moh` (the router over the first-party workflow skills and the moh
docs) worked by embedding the skill's entire `SKILL.md` into the *user
message* sent to the session. Two problems followed:

1. **The event log is the session** (principle 2): the oversized
   `user_message` was persisted verbatim, replayed on resume, fed to the
   memory extractor's transcript window, and shown as the session title
   source. A prompt-assembly detail leaked into every projection of the
   log.
2. **The TUI rendered the whole blob**: every `/ask-moh` turn opened with
   100+ lines of skill text in the transcript, and the user's actual
   question was buried at the end.

The underlying misplacement is architectural: a skill's instructions are
prompt material, and principle 6 says the core owns the system prompt
(`PromptComposer`). Clients injecting prompt text through `send()` is a
client touching the prompt by smuggling it through user content.

## Decision

1. **`SendOptions.prompt`** — `AgentSession.send(text, options?)` accepts
   an optional one-turn prompt injection:
   `{ prompt?: { name: string; text: string } }`. `name` identifies the
   skill (audit + chrome); `text` is the full instructions (body only; the
   caller strips frontmatter). The user message that reaches the model and
   the log stays exactly `text` — the clean question.
2. **`PromptComposer` skill section** — while a turn-scoped skill prompt is
   active, the `skills` section renders the injected skill **in full**
   instead of the ordinary index, prefixed with the fixed framing line
   `Follow the "<name>" skill for this turn. Its instructions are
   reproduced verbatim below.` The section is reassembled every model call
   within the turn, then drops back to the index. No new section is added:
   the fixed `SECTION_ORDER` is unchanged.
3. **`skill_invoked` chrome event** — the turn-scoped prompt is recorded in
   the log as `{ type: "skill_invoked"; name: string }`, appended
   immediately before the turn's `user_message`. It is chrome: replay
   ignores it, the model never sees it, and the TUI projects it as a
   discreet `◈ skill: ask-moh` line. This keeps the event log complete
   without re-polluting it with the prompt body.
4. **Turn scope only** — the injection lives exactly one turn (dropped in
   the turn's settle path, before memory runs). There is no session-scoped
   variant: persisting injected prompt text across resume would re-introduce
   the leak this ADR removes. If a future flow needs a sticky skill, it
   goes through a persisted chrome event and explicit replay handling, as
   a separate decision.

## Consequences

- `/ask-moh`'s transcript shows the user's question plus one indicator
  line; the skill body is invisible chrome living in the system prompt.
- `beforeModelCall` extensions see the skill in `prompt.sections.skills`
  (read-only, as before) — no new hook surface.
- The `readBundledSkill` export keeps feeding the TUI, but its content now
  stops at the prompt seam instead of transiting the message history.
- Resume of a session with `skill_invoked` events replays clean user
  messages; the skill body is never needed again after its turn (its
  effects live in the assistant reply).
