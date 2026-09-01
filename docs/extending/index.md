# Extending moh

Two different people plug into moh, and this section keeps them apart.
Each chapter is written for exactly one of them — pick yours and skip the
other.

| Chapter                                        | Who it is for                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Writing extensions](extensions.md)            | **Extension writers** — you build a module against the `@moh/extension` contract: phase hooks, veto semantics, lifecycle, failure behavior. |
| [Embedding moh as a library](library-usage.md) | **Library users** — you embed `@moh/core` in your own program: `sessionFromConfig`, consuming the event log, headless permission seams.     |
| [Authoring skills](skills.md)                  | Either persona, and end users: pi-compatible `SKILL.md` files for both moh and pi.                                                          |
| [Portability across machines](portability.md)  | End users: the sync-tolerance contract for `~/.moh/`, project identity, and serial cross-machine resume.                                    |

The boundary between the personas is the same one that governs the
architecture (see [principle 4](../principles.md)): everything that plugs
in is additive and can only _restrict_ — extensions veto tool calls, they
never widen permissions; library users inject consent seams, they never
bypass the permission spine. If you find yourself wanting a hook that
grants permissions or rewrites the system prompt, that is a core change —
open an issue instead.

## pi compatibility

moh deliberately reuses pi's conventions where they are cheap for users to
keep dual-compatible:

- **Skill format**: `skills/<name>/SKILL.md` with `name` + `description`
  frontmatter and relative-path references — identical grammar, so the
  same skill directory works in both tools (see [skills.md](skills.md)).
- **Instruction files**: AGENTS.md is canonical (CLAUDE.md silent
  fallback); moh injects it (plus CONTEXT.md, under a shared character
  budget) into the system prompt.
- **AGENTS.md conventions**: the same "repo guidance for coding agents"
  pattern, including branch, language and workflow conventions.

And deliberately differs:

- **Locations**: moh's user-level home is `~/.moh/`, not `~/.pi/`.
- **First-party workflow**: moh bundles the Matt Pocock workflow skills
  behind workflow mode (`/workflow on|off`); pi has no such mode.
- **Extensions**: pi extensions are _not_ compatible with
  `@moh/extension` — moh's contract is its own additive-only API with a
  mandatory `apiVersion` (see [extensions.md](extensions.md)).
- **Sessions**: moh sessions are append-only JSONL event logs under
  `~/.moh/projects/<slug>/`, not pi's session format.

## Keeping these docs honest

These chapters describe only what exists today, on the public surface
curated by [ADR-0004](../adr/0004-public-surface-criterion.md) — no
promised APIs. The light alignment rule: **a PR that changes a public door
updates the affected chapter in the same PR.**
