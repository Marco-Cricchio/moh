# Retro findings

`moh retro` reviews improvement findings accumulated automatically from closed sessions.

The report is pull-based and does not change project files or the system prompt. Findings are ordered by confidence and include their evidence signature. Use `--json` for machine-readable output.

```text
moh retro
moh retro --json
moh retro --dismiss <signature>
moh retro --apply <signature> --yes
```

Dismissal is durable for the exact evidence signature. A materially new observation has a new signature and can be proposed separately. Applying a finding records an explicit user-approved decision; steering files are never modified automatically.
