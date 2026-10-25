# Lean bench (#1633)

Measures whether base prompt v3 and `moh init`'s `docs/agents/code-quality.md`
reduce structural drift, and decides slice 4 (the executable gate) of #1633.
Dev tooling; nothing in `packages/` imports it.

```sh
bun scripts/lean-bench/bench.ts run    --model <endpoint/model-id> --out <dir> [--runs 3] [--only moh-776 ...] [--conditions a,b]
bun scripts/lean-bench/bench.ts judge  --model <endpoint/model-id> --out <dir>
bun scripts/lean-bench/bench.ts report --out <dir>
```

`run` and `judge` are resumable: a cell that already has its output is skipped.
Keep `<dir>` outside the repository.

## Corpus

`corpus.json`: ten closed moh feature issues merged before principle 8
(2026-10-14) whose base holds no earlier commit for the same issue, each
frozen as `base` (the PR's `baseRefOid`: a merge's first parent can already
contain the PR's commits) and
`prompt` (the issue text at corpus time); `reference` names the PR that
shipped it. `strip` removes the repository's own doctrine (AGENTS.md,
CLAUDE.md, `.moh/`) so the conditions start from the same blank slate;
`setup` runs after the setup commit. An external repository is one more entry
with `repo` pointing at its local checkout.

## Conditions

Each cell is a history-free snapshot of `repo` at `base` (`git archive`, then
`git init`; a worktree would expose the shipped solution through its refs),
fetched by SHA when missing. The base prompt is injected through the
`.moh/prompts/system.md` override:

- `v2` — the BASE_PROMPT text at `8f06512d` (develop before #1634);
- `v3` — the BASE_PROMPT text of this checkout;
- `v3+code-quality` — v3 plus `moh init` (AGENTS.md moh section,
  `docs/agents/code-quality.md` and, since #1685, `moh.json` `checks`);
- `v3+code-quality+apply` — the same, then a second fresh `moh run` over
  the change with the code-review skill in apply mode (`apply HEAD`), as
  `/implement` runs it (#1633 slice 2). Its events are `apply-events.jsonl`;
  the diff and metrics cover the end state.

`--conditions` runs a subset; a comparison across moh versions belongs in a
fresh `<dir>`, run with both of its conditions.

The model runs once per cell through this checkout's `moh run --auto-accept`;
the diff is taken against the setup commit. Each run gets a throwaway HOME
holding a copy of `~/.moh/config` (endpoints and credentials, mode 600) with
`lanes.auto` off, deleted after the run: an auto-lane would move the edits out
of the cell and lose the gitignored prompt override, and a HOME under `<dir>`
would point the model at earlier cells. No user sessions, skills or
extensions reach a run.

## Metrics

Per cell (`metrics.json`):

- `linesAdded`, `linesDeleted`, `filesAdded`;
- `uncalledSymbols` — declarations added by the diff whose name occurs only
  once in the tree (TS/JS/Python declaration keywords; a test reference counts
  as a use);
- `duplicatesTouchingChange` — jscpd 4.0.5 clones (≥50 tokens, whole tree)
  with a fragment in a changed file;
- `highCcnFunctions` — lizard 1.17.10 functions with CCN > 10 in the changed
  files.

The judge (`judge.json`) gets only the diff, in shuffled order from an empty
directory, and classifies it against the smell baseline of the code-review
skill. `knip` from the #1633 draft is left out: it needs per-repo
configuration, and `uncalledSymbols` covers unused exports in any language.

## Pre-registered criteria

Structural findings are the judge's Speculative Generality, Duplicated Code and
Middle Man. `report` averages runs per task, then tasks per condition. If
`v3+code-quality` cuts structural findings by at least 50% against `v2`, with
`uncalled`, `duplicates` and `highCcn` no worse, slice 4 is archived;
otherwise slice 4 is justified, and jscpd and lizard are its recipe
candidates.

Slice 2 (`/code-review apply`): if `v3+code-quality+apply` cuts structural
findings by at least 30% against `v3+code-quality`, with `linesAdded` no
higher, apply keeps its place in `/implement`; otherwise the hook is
reverted and the mode stays available on demand. `report` prints each
verdict whose two conditions are complete.

Cost: 10 tasks × 3 conditions × 3 runs = 90 model runs plus 90 judge runs.
