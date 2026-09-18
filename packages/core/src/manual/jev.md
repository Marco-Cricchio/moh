# Jev (TypeSafe)

Jev is a second account moh can consult next to your model: a service run
by TypeSafe, hosted in the US, that returns **typed judgments** — one
probability or one choice per question moh asks — and never text. moh uses
those judgments to make small decisions about a turn; it never asks Jev to
write anything you read, and it never passes a judgment off as a model
reply. Jev is optional: moh is designed to work exactly as described on the
other pages without it.

## Activating it

You activate Jev from the TUI Settings panel, entry **Jev (TypeSafe)**:

- **API key** — a masked input. On submit moh makes one real validation
  call: a key the service rejects is not saved, while a service that cannot
  be reached *is* saved, with its own message saying the key will activate
  as soon as Jev is reachable.
- **Status** — a read-only row: `active (key …abcd, timeout 2500ms)` or
  `inactive`.
- **Remove** — clears the key; the bundled extension is then not registered
  at all, from the next session on.

There is no first-run wizard and no on/off toggle: **a stored key is the
state**. Enter the key from the panel — that is where it is validated and
masked, so hand-editing the configuration file is not a supported way to
activate Jev.

The key lives in `~/.moh/config` (the `typesafe` block, key `apiKey`) —
the user configuration, never moh.json: a cloned project must not be able
to activate an account on your behalf. The per-call timeout
(`typesafe.timeoutMs`, default 2500 ms) is configuration only — there is no
timeout field in the panel. The Config reference page lists the block.

## What leaves your machine

The disclosure shown next to the Settings entry, verbatim:

_judgments send the command, working directory and git branch/state to
TypeSafe (US). TypeSafe declares no training on inputs._

## When Jev is unavailable

Nothing else about moh changes:

- **No key** — the bundled extension is never registered: zero hooks, zero
  calls. The session notes `jev: inactive (no api key)` at start and moves
  on.
- **Key present, service down or unreachable** — moh fails open. Every
  judgment comes back as "no judgment" and the agent behaves exactly as it
  does without Jev. While an outage lasts you see one `∅ jev offline` chip
  in the TUI footer (`moh run` writes one line to stderr instead, and the
  exit code is never affected). The chip is announced once per outage and
  cleared as soon as Jev answers again.
- **No substitute** — a judgment moh cannot obtain is never replaced by a
  model call. The use case that needed it simply does not apply to that
  turn.

## Checking the state: moh jev status

```
$ moh jev status
  jev      active (key …abcd, timeout 2500ms)
  routing  off

$ moh jev status --json
{"active":true,"keyHint":"…abcd","timeoutMs":2500,"routing":false}
```

The command reads your configuration and never calls TypeSafe — the key was
validated when you saved it. It always exits 0, and when Jev is inactive it
prints the way back to the Settings panel.

## Use cases: not shipped yet

What this release ships is the infrastructure only: it registers no hook by
itself, so activating Jev changes nothing about a turn until a use case
lands. The planned ones, with their opt-in state:

- **Guardrail** — judges a tool call before it runs and can hand a call that
  is neither clearly safe nor clearly dangerous to the ordinary permission
  prompt. Planned: active whenever Jev is.
- **Model routing** — picks a model per turn from the tiers you label.
  Planned: opt-in, off by default.
- **The ★★ pack** — prompt classification, quality gate, MPM rerank,
  anti-injection, compaction cut, skill suggestion. Planned: one opt-in
  each.

Those use cases own their questions, thresholds and calibration, and they
ship in their own release; this page grows with them.
