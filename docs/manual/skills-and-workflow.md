# Skills & workflow mode

Skills are markdown instruction packages the agent loads on demand.
They are discovered from `~/.moh/skills/` (user) and `.moh/skills/`
(project; project wins) and surface as slash commands.

## Workflow mode

Workflow mode (per user, off by default) enables the first-party
workflow: the bundled skills — grilling, to-spec, to-tickets, implement,
tdd, code-review, triage, diagnosing-bugs, and more — as slash commands,
plus the wayfinder frontier panel.

```
/workflow on     # copies the bundled skills to ~/.moh/skills/
/workflow off    # hides them; base behavior never changes
```

With workflow mode **off**, nothing about the agent's base behavior
changes — the slash commands simply do not exist.

## Skills as slash commands

Each first-party skill has a matching command (`/implement`,
`/tdd`, `/grilling`, …) available while workflow mode is on. Arguments
after the command are passed to the skill: `/implement #457` runs the
implement skill against an issue. Your own skills in `.moh/skills/`
appear in the same completion popup.

## /ask-moh

`/ask-moh <question>` is the router: it figures out which skill or flow
fits your situation — or answers questions about moh itself, grounded in
the user manual, citing the section it used. Run it with no argument to
get the routing overview.
