---
name: implement
description: "Implement a piece of work from a confirmed plan or ticket. Use when the user asks to build, fix, or apply a spec."
minMohVersion: 0.1.0
---

# implement

Implement the confirmed plan test-first where a seam exists.

1. Re-read the plan/ticket and the acceptance criteria.
2. Run the typechecker; keep it green.
3. Add or update tests for the behavior; run the single file.
4. Implement the smallest change that passes.
5. Run the full test suite once at the end.
6. Review your own diff before reporting done.
