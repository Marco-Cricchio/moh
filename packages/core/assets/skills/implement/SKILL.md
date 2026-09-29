---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
minMohVersion: 0.1.0
---

Implement the work described by the user in the spec or tickets.

For non-trivial implementation work, load and follow the `moh-implementation-flow` companion skill before exploration.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work, then /pr to draft the PR body (summary view, before/after evidence, merge danger). After the PR lands, /retro turns the session into environment improvements.

Commit your work to the current branch.
