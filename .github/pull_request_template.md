## Lean checklist (principle 8)

Principle 8 of [docs/principles.md](https://github.com/Marco-Cricchio/moh/blob/develop/docs/principles.md) and [ADR-0078](https://github.com/Marco-Cricchio/moh/blob/develop/docs/adr/0078-lean-by-default.md): every door, option and abstraction has a caller.

- [ ] New exports from a package entry are listed here and justified (imported by another package in this change, or documented library/extension API).
- [ ] No new option, parameter or injection seam without a production caller.
- [ ] No new file without a new concept.
- [ ] Code made unused by this change is deleted.
- [ ] Surface lists and ratchet baselines are updated when they change: `packages/core/test/entry-surface/` (G2), `packages/core/test/keep-criterion/` (G3), `packages/core/test/unused-exports/` (G4).
