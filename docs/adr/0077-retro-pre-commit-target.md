# ADR-0077: Retro apply gains a generated pre-commit target

Status: accepted · Date: 2026-10-12
Related: ADR-0075 (retro findings — accumulation in core, consumption at consent), #1356, #1362 (the hook's shared git dir), #1364 (placement, and the TUI create-missing grant)

## Context

ADR-0075 gave `missing-guardrail` findings no application target: "a check is
wired in a workflow or a hook — a YAML file a markdown bullet must not be
appended to." The posture was right about markdown (and stays right about CI
YAML, which is project-specific) but wrong about the pre-commit shape: the
finding is deterministic from repo state (package.json defines lint/test,
nothing wires them), so with no target the apply gate refuses every attempt
and the finding re-accumulates forever. The only escape was a manual
dismissal — findings should shrink as projects mature.

## Decision

The `missing-guardrail` `pre-commit:unwired` shape gains a real, universal
target: `.git/hooks/pre-commit`, generated on confirmed apply.

- `proposeRetroApplication` maps the shape to target `.git/hooks/pre-commit`,
  kind `automated-check`, matched by the finding's fixed signature
  (`pre-commit:unwired`), never by the free-text evidence (length-capped,
  redacted). The hook script is derived at apply time from repo state (the
  lint/test scripts package.json defines, the package manager the lockfiles
  reveal, `npm run` fallback), under `set -e` so the first failing check
  blocks the commit; when no check is derivable (package.json unreadable or
  without lint/test), apply refuses rather than write an always-passing hook.
- **Never overwrite**: an existing executable `.git/hooks/pre-commit` is
  refused with a visible error. A hook that exists but is not executable
  (a fresh clone strips the bit) is made executable instead — that is the
  exact state the detector keeps firing on, and rewriting it is what the
  never-overwrite rule guards against. The `createMissing` consent for
  missing markdown steering files does not apply: for the hook, creating
  it IS the write.
- The gate is unchanged: explicit `confirm`, nothing runs by itself. `.git/`
  is untracked, so a local hook is the correct default; a committed-hook
  strategy (husky etc.) remains the user's choice. moh writes the hook and
  never executes it.
- **Bare whole-tree test runs are never generated (#1363):** a `test`
  script whose value is a bare single-process whole-tree run (`bun test`,
  `npm test`, a bare `vitest`/`jest`/`node --test`) is excluded from the
  derived checks — inside a blocking pre-commit hook it is exactly the
  minutes-long gate such projects document against. When a phased test
  script exists it is emitted as-is (the repo's own script decides the
  phasing); when the bare script is the only derivable check, apply
  refuses with "the test script is a bare whole-tree run — wire
  scripts/test.sh first" rather than write a hook that blocks commits or
  an always-passing one. The correct runner is project-specific and is
  never invented here; in this repository the local hook was replaced by
  hand with `scripts/test.sh`.
- **Placement (decided 2026-10-12, issue #1364 discussion):** the two
  target kinds follow their nature. Markdown steering files are project
  *source* — they write into the session's worktree (a lane included) and
  reach the whole project through the lane's own branch, like any other
  change; the retro store is project-keyed, so an abandoned lane loses
  nothing: the finding re-surfaces. The generated git hook is git
  *infrastructure* — it writes into the shared git dir (#1362). CODING_STANDARDS.md
  stays a committed source file (never gitignored): a coding standard is
  by definition shared with anyone who produces code in the repository.
- The TUI footer's "(missing — y creates it)" is a real grant: when armed,
  the modal passes `createMissing` to the apply gate (#1364).
- The project-root escape check in `applyRetroApplication` gains one
  exact-path carve-out: `.git/hooks/pre-commit` (a generated hook outside
  the project tree but inside the clone). Every other outside-root target
  stays refused.
- Convergence is by construction: once the hook is executable the detector
  stops emitting `pre-commit:unwired`; the stored finding closes with one
  dismissal (the signature is fixed).

## Consequences

- This is the first non-markdown application target, and the only write
  outside the project tree. The carve-out is exact-path, not a general
  `.git/` permission.
- The `ci:unwired` shape keeps its review-only posture: a workflow file is
  project-specific YAML moh must not generate.
- Markdown targets (AGENTS.md, CODING_STANDARDS.md) keep their append-only,
  `createMissing` behavior unchanged, byte for byte.
