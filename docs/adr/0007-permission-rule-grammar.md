# ADR-0007: One permission-rule string grammar in the core

Status: accepted · Date: 2025-11-30 · Issue: #104 · Spec: internal permission-rule-grammar spec (local)

## Context

The glossary promised "one grammar shared by moh.json, TUI, and CLI", but the string form of rules was split three ways: the CLI parsed `--allow bash:git` with its own translator (`cli/src/permission-flags.ts`), the TUI hand-rendered a display-only format (`bash: git → allow`) that nothing could parse back, and the core had no string form at all. Any rendered string fed back into overrides would silently fail to parse.

## Decision

The CLI's terse grammar is the **canonical** writable-and-reparseable permission-rule string form, owned by the core:

```
rule      := tool | tool ":" argspec
argspec   := command-prefix (bash) | path-glob (any path-arg tool)
```

Examples: `bash` (bare tool), `bash:git status` (shell-word token prefix), `write:src/**`, `edit:docs/*.md` (root-anchored path globs). The *effect* ("allow"/"deny") is not part of the string; it is supplied by the caller, as the CLI's `--allow`/`--deny` flags already do.

`packages/core/src/permissions.ts` exports:

- `formatRule(rule)` — the only encoder of rule strings.
- `parseRule(str, effect, tier?)` — the only decoder. Rejects empty rules, compound bash commands (one flag per segment), and `tool:` with no matcher (`RuleError`).
- `overridesFromFlags(allow, deny)` — the CLI seam: same flag strings, byte-identical behavior, machinery in core. `cli/src/permission-flags.ts` is gone.

The TUI (`tui/src/permission-gate.ts`) renders its "always"-rule previews via `formatRule`; no client hand-builds rule strings anymore. Round-trip tests (`parseRule(formatRule(rule))` deep-equals the original across bash prefixes, path globs, bare tools and both effects) keep a second grammar from ever being reborn.

Exports are justified per ADR-0004: both `@moh/cli` and `@moh/tui` consume them.

## Semantics notes

- `parseRule("write:src/**", …)` yields a rule scoped to `write`; `overridesFromFlags` widens path rules into the shared `pathAllow`/`pathDeny` lists (the resolver's `*` semantics), preserving pre-existing CLI behavior.
- Tokens containing shell-significant characters are double-quoted on format; the grammar has no escape sequence, so tokens mixing `"` with whitespace cannot round-trip (documented limit).

## Amendment (#775, ADR-0029): the URL-glob argspec

The browser tool needs a third argspec semantic. Browser rules take the
`browser:<action> [url-glob]` form:

```
browser:click https://app.example.com/**     // act-tier clicks on this site
browser:fill http://localhost:3000/app/**    // fills on a dev server path
browser:click                                // global form: every click, any URL
```

- The rule's `tool` carries the action scope (`browser:click`); the matcher
  is a **URL glob**: scheme+host+path matched against the page URL at
  action time, exact host (no implicit subdomain match), `**` spanning
  path segments, `*` within one. A glob with an explicit port requires
  an exact port match; a glob without one matches any page port
  (localhost dev servers move around); a missing path matches the origin
  root only.
- URL-scoped rules need a page URL in the call args — the browser tool
  supplies it (`Tool.gateArgs`, #775); without one they never match and
  the call falls back to the default ask.
- Config tier: `permissions.overrides.browserAllow` / `browserDeny`
  (canonical rule strings, parsed by `parseRule`). Runtime tier: the
  act-tier "always for this site" answer writes `browser:<action>
  <origin>/**` for the current session only — never persisted to
  moh.json, never proposed proactively.
- Specificity: URL-scoped rules beat the global `browser:<action>` form
  within a tier; deny still wins ties (#699).

## Consequences

- One string form everywhere: CLI flags, docs, and TUI previews agree, and every formatted rule reparses.
- `moh.json` overrides keep their structured schema (`tools`/`bashAllow`/`pathAllow`/…); the canonical gramm