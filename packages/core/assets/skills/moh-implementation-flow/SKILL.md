---
name: moh-implementation-flow
description: Moh execution discipline for non-trivial implementation work. Load from implement before exploration.
minMohVersion: 0.1.0
---

# Moh Implementation Flow

Use this companion for **non-trivial implementation work**: work that needs exploration, more than one coherent change, or could be interrupted by a turn budget or concurrent work. It supplements the implementation workflow; it does not replace the issue or its acceptance criteria.

## Start safely

1. Read the issue or specification and the repository instructions.
2. Create a dedicated branch **before exploration**. Do not mix the work with another task or commit unrelated working-tree changes.
3. When investigation has independent, read-only questions, delegate them to subagents in parallel. Keep dependent investigation in sequence; do not create parallelism merely for its own sake.
4. Confirm a product decision or a TDD seam only when it is genuinely unresolved. Once required decisions are settled, continue autonomously.

## Build in verified vertical slices

Implement one coherent, observable behavior at a time:

1. Establish the agreed test seam and add the smallest useful test where applicable.
2. Make that behavior work.
3. Run the relevant targeted checks and typechecking.
4. Continue with the next slice only after the current behavior is verified.

For non-trivial work, make an **atomic intermediate commit** after a verified, coherent, recoverable slice. A commit must contain only the work for that slice and must exclude unrelated working-tree changes. Do not fragment trivial changes into artificial commits: make an intermediate commit only when it preserves real verified progress against interruption, turn limits, or concurrent worktree changes.

## Finish without unnecessary pauses

Proceed through routine implementation, verification, review, and commit without asking for approval at ordinary phase boundaries. Stop only when one of these applies:

- an owner decision is unresolved;
- concurrent working-tree state is unsafe to modify or isolate;
- an external failure blocks execution; or
- the execution budget is exhausted.

At completion, run the full suite once, perform the two-axis `code-review` (Standards and Spec), address its findings, and commit the completed work. Creating a PR and merging a branch require an explicit owner request; do neither automatically.
