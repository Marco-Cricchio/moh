# pi compatibility

moh deliberately reuses pi's skill format and instruction-file conventions where they are cheap for users to keep dual-compatible.

## Compatible

- **Skill format**: `skills/<name>/SKILL.md` with `name` + `description` frontmatter and relative-path references — identical grammar, so the same skill directory works in both tools (see [skills.md](skills.md)).
- **Instructions files**: AGENTS.md is the canonical instruction file, with CLAUDE.md as a silent fallback (spec §10, ticket #18). Both tools read AGENTS.md from the project root; moh injects it (plus CONTEXT.md, under a combined character budget) into the system prompt.
- **AGENTS.md conventions**: moh follows the same "repo guidance for coding agents" pattern, including branch, language and workflow conventions.

## Deliberately different

- **Locations**: moh's user-level home is `~/.moh/` (skills, prompts, config), not pi's `~/.pi/`.
- **First-party workflow**: moh bundles the Matt Pocock workflow skills and gates them behind workflow mode (`/workflow on|off`); pi has no such mode.
- **Extensions**: pi extensions are not compatible with `@moh/extension` — moh's contract is its own additive-only API with mandatory `apiVersion` (see [api-reference.md](api-reference.md)).
- **Sessions**: moh sessions are append-only JSONL event logs under `~/.moh/projects/<slug>/`, not pi's session format.
