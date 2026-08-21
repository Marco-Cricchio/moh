# Extending moh

Guides for everything that plugs into moh without changing the core:

- [API reference](api-reference.md) — the `@moh/extension` contract, its hooks, and the versioning policy.
- [Authoring skills](skills.md) — pi-compatible SKILL.md files and progressive disclosure.
- [pi compatibility](pi-compatibility.md) — what moh shares with pi and where it deliberately differs.

Extensions and skills are additive by design: hooks observe and *restrict*, never grant (see [principle 4](../principles.md)). If you find yourself wanting a hook that widens permissions or rewrites the system prompt, that is a core change — open an issue instead.
