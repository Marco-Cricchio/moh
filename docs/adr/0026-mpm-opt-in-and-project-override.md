# ADR-0026: MPM is opt-in by default, with an explicit per-project override

Status: accepted · Date: 2026-09-13 · Reverses: the restrict-only part of #618's config precedence

## Context

MPM shipped (#613–#621) as **automatic and opt-out**: `~/.moh/config` owned
the default (`enabled: true` when absent) and the project moh.json section
was restrict-only — the schema accepted `enabled: false` and nothing else,
so a project could never force MPM on against a user disablement. Two
consequences surfaced once the wiring gap was closed (initial-build fix on
develop):

1. **Every project gets MPM by default.** Users who never asked for it pay
   the discovery/extraction cost on first open of each workspace.
2. **The only per-project control was negative.** A user who wants MPM on
   globally but off in one repo could express it; a user who wants it off
   globally and on in one repo could not.

The owner ruled MPM should be **fully functional but explicitly enabled**:
off by default in public releases, with a per-project activation surface
inside the TUI settings panel.

## Decision

1. **Global default: disabled.** `resolveMpmConfig` treats an absent or
   non-`true` user `mpm.enabled` as off (`disabledReason: "user"`). MPM is
   opt-in.
2. **The project moh.json `mpm` section becomes a two-way override.** An
   explicit `enabled: true` opts the project in over a global default off;
   an explicit `enabled: false` opts it out over a global opt-in. Absent
   means inherit. The #618 restrict-only schema (`z.literal(false)`) is
   widened to `z.boolean()`.
3. **Precedence: explicit project beats inherited user default.** This
   reverses #618's "user disablement wins over everything" rule: the user
   default is what the project inherits, not a ceiling over it. Quota
   strictness and exclusion union are unchanged.
4. **The activation surface is the settings panel row "Moh Project Map"**
   with three states — inherit / on (this project) / off (this project) —
   writing moh.json through the existing guardian (`writeMohConfig`),
   removing the section entirely on inherit. Changes apply to new sessions;
   gating remains a `sessionFromConfig` concern (no hot-reload).

## Consequences

- Fresh installs never run MPM unless the user enables it globally or a
  project opts in.
- `moh mpm` diagnostics report the honest disabled reason (`user` vs
  `project`) under the new matrix.
- Documentation (glossary, manual, config reference) is amended in the
  same change; #618's "restrict-only" wording is retired.
- The initial-projection build fix stays gated on the resolved config: a
  disabled project builds nothing, writes nothing.
