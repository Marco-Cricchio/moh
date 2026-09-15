---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
minMohVersion: 0.1.0
---

Implement the work described by the user in the spec or tickets.

For non-trivial implementation work, load and follow the `moh-implementation-flow` companion skill before exploration.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and — at the end — the full suite only once and only when the change touches shared code (core, session assembly, test harness); for a package-confined change, that package's test dir is enough (the PR CI run covers the rest, with PTY retry). After a fix, re-run only the failing test files, never the full suite.

Once done, use /code-review to review the work.

Commit your work to the current branch.
