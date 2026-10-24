# ADR-0080: Repo-declared checks

Status: accepted · Date: 2026-10-24
Related: ADR-0078 (principle 8), ADR-0079 (base prompt v3, `code-quality.md`), ADR-0037 (`requestTurn`), ADR-0067 (`tool:<name>`), ADR-0077 (retro pre-commit target), #1633 (charter and design)

## Context

#1633's measurement ([verdict](https://github.com/Marco-Cricchio/moh/issues/1633#issuecomment-6387520655))
found that base prompt v3 plus `docs/agents/code-quality.md` cut structural
findings by 24% against v2 — below the pre-registered 50% — so the
executable gate (slice 4) is justified. The owner settled three decisions
before the design ([design](https://github.com/Marco-Cricchio/moh/issues/1633#issuecomment-6388564716)).

## Decision

1. **The repo declares commands; moh owns no tool.** A check is a shell
   command and its exit code: non-zero is a failure, and moh never parses
   a tool's output. Any language and any tool works; a threshold is
   whatever flag the repo's command uses. Rejected: a moh-managed toolchain
   on the browser-toolchain pattern (npm packages only — no multi-language
   complexity tool) and a dependency shipped in the binary.
2. **The declaration lives in `moh.json` `checks`**: schema-validated and
   documented like every other project key.
   `[{ name, run, block?, timeoutMs? }]`; `block` defaults to `false`
   (report only), and `block: true` is how a repo declares a threshold it
   wants resolved before a change is called done. `docs/agents/code-quality.md`
   points at the key in one sentence, so the commands live in one place.
   Rejected: a fenced block inside `code-quality.md` (configuration in
   prose, no schema).
3. **The runtime is a first-party bundled extension** on doors that already
   exist — `afterTurn`, `runTool("bash")` through the permission gate,
   `requestTurn` with the core's two-synthetic-turn bound. Repo-declared
   commands run only after a consent stored per hash of the `checks` array:
   `moh.json` proposes, it never activates anything by itself. Rejected: a
   new step in the core's agent loop.

`moh init` proposes the checks: the repo's own tools when present (`knip`,
`eslint` in `package.json`; `ruff`, `radon` in `pyproject.toml`), else two
pinned on-demand commands (`jscpd` 4.0.5 via `npx`, `lizard` 1.17.10 via
`uvx`), report only. It writes them into a new `moh.json` and never edits an
existing one — it prints the proposal instead.

## Consequences

- Delivery in three PRs: 4a (this ADR, the schema, the `moh init`
  proposal), 4b (the extension in report mode: consent, change detection,
  sequential runs, status, an `extension_event` per run), 4c (`block: true`
  drives `requestTurn`; an unresolved failure stays visible).
- Until 4b ships the key is validated, documented and proposed, but nothing
  runs it. The activation-context field that hands `checks` to the
  extension lands with its consumer in 4b, per principle 8 (b).
- moh never blocks a commit; a hard gate stays the repo's own pre-commit
  hook (ADR-0077).
