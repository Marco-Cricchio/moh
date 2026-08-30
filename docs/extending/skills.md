# Authoring skills

**Who this is for:** end users and either persona from the [intro](index.md)
— skills are the lightest way to teach moh (and pi) new behavior, with no
code at all.

Skills in moh are **pi-compatible**: a skill is a directory containing a `SKILL.md` with YAML-ish frontmatter.

## Format

```
skills/
  my-skill/
    SKILL.md
```

`SKILL.md` frontmatter requires exactly two keys:

```markdown
---
name: my-skill
description: Use when the user wants to frob widgets.
---

Instructions for the agent go here. Reference sibling files with
**relative** paths (e.g. `./examples/basic.md`); they resolve against
the skill's directory.
```

## Discovery locations

- `~/.moh/skills/` — user-level
- `.moh/skills/` — project-level; **wins** on a name clash

First-party skills shipped with moh are ordinary files copied into `~/.moh/skills/` at install/upgrade; they are updated from the workflow upstream (the `index.json` served raw from the moh repo's main branch — regenerate it with `bun run scripts/gen-skills-index.ts` whenever a bundled skill changes and commit the result) only when unmodified (hash check) and are active only with workflow mode on. One exception: **`ask-moh`**, the router skill — its `SKILL.md` is read straight from the bundle by the base `/ask-moh` command (always available, workflow mode on or off), which injects the current workflow state so the skill can route around the mode gate. The skill body reaches the model through the turn-scoped skill prompt (ADR-0011): the command sends the clean question via `session.send(text, { prompt: { name, text } })`, the `skills` prompt section renders the skill in full for exactly that turn, and the log records a `skill_invoked` chrome event instead of polluting the user message.

## Turn-scoped skill prompts (ADR-0011)

Any client can attach one skill's full instructions to a single turn:

```ts
await session.send("which skill fits?", {
  prompt: { name: "ask-moh", text: skillBody }, // body only, frontmatter stripped
});
```

- The body replaces the `skills` section for that turn (framed with a fixed "follow this skill" line), then the section falls back to the ordinary index.
- The user message and the persisted `user_message` event stay the clean text; a `skill_invoked` chrome event records the invocation.
- The injection is dropped when the turn settles (done, error or cancelled) — it never survives into the next turn or a resume.

## Progressive disclosure

Only the `name`—`description` pair enters the system prompt (via `PromptComposer`'s `skills` section, which also shows each skill's `SKILL.md` location). The full `SKILL.md` is never injected automatically — the agent reads it with the `read` tool on demand, when the description matches the task. Keep descriptions as trigger conditions ("Use when…"), and keep hot instructions short.

Notes:

- No auto-triggering in v1: the model decides based on the index.
- There is no limit on skill count in the index, but each entry costs prompt tokens — curate.
