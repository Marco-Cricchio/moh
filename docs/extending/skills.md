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

First-party skills shipped with moh are ordinary files copied into `~/.moh/skills/` at install/upgrade; they are updated from the workflow upstream only when unmodified (hash check) and are active only with workflow mode on.

## Progressive disclosure

Only the `name`—`description` pair enters the system prompt (via `PromptComposer`'s `skills` section). The full `SKILL.md` is never injected automatically — the agent reads it with the `read` tool on demand, when the description matches the task. Keep descriptions as trigger conditions ("Use when…"), and keep hot instructions short.

Notes:

- No auto-triggering in v1: the model decides based on the index.
- There is no limit on skill count in the index, but each entry costs prompt tokens — curate.
