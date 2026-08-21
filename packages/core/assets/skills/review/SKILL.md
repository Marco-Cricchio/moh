---
name: review
description: "Review a diff or branch against the repo standards and the originating spec. Use when the user asks for a review."
minMohVersion: 0.1.0
---

# review

Review along two axes, reporting them separately.

- **Standards**: does the code follow this repo's documented conventions?
- **Spec**: does the code match what the issue/spec asked for, including acceptance criteria?

For each finding give file:line, why it matters, and the smallest fix. End with a verdict: approve, or the blocking items.
