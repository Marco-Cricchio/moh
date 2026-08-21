---
name: diagnose
description: "Diagnose a bug or regression with a evidence-first loop. Use when the user reports something broken, failing, or slow."
minMohVersion: 0.1.0
---

# diagnose

Loop until the root cause is proven, not guessed.

1. Reproduce the failure with the smallest possible input.
2. State one hypothesis and the single observation that would falsify it.
3. Make only that observation; record the result.
4. Repeat or conclude. Distinguish root cause from symptom.
5. Propose the fix with its blast radius.

Never fix before the root cause is stated and supported by evidence.
