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
- **Model routing** — the opt-in for the per-turn router (off by default;
  see below). It is the only switch in the entry.
- **Status** — a read-only row: `active (key …abcd, timeout 2500ms)` or
  `inactive`.
- **Remove** — clears the key; the bundled extension is then not registered
  at all, from the next session on.

There is no first-run wizard: **a stored key is the state**. Enter the key
from the panel — that is where it is validated and masked, so hand-editing
the configuration file is not a supported way to activate Jev. The routing
opt-in is changed the same way, and both are read when a session starts:
a session already open keeps the settings it was assembled with.

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
validated when you saved it. It exits 0 whether Jev is active or not
(information, not verification) and, when Jev is inactive, prints the way
back to the Settings panel. Only a malformed `typesafe` section is an error
(exit 2), like every other broken config section.

## Use cases

Two use cases ship today: the bash guardrail and the model router.

### Bash guardrail

The first use case is the **bash guardrail**: every `bash` tool call is
judged by Jev with one call — four questions (`destructive`, `in_scope`,
`exfiltration`, `risk_level`) — before your permission rules are even
consulted. The verdicts:

- **deny** (destructive or exfiltration probability > 0.75, or risk ≥ 1.5)
  — the call is vetoed and the model receives the reason plus an
  actionable suggestion ("scope the path to /tmp and re-run").
- **ask** (either probability in 0.40–0.75, or risk in 0.75–1.5) — the
  call reaches the ordinary permission prompt even in auto-accept mode,
  marked **Jev: caso incerto (…)** with the key probability. The prompt
  offers yes/no only: a guardrail false positive must never write an
  "always" rule that disarms the filter.
- **pass** — nothing changes; your rules and modes decide as always.

In **yolo** mode only the lethal checks run (destructive, exfiltration):
they can still deny, but Jev never prompts — yolo means zero prompts.
In headless (`moh run`) an "ask" degrades to a denial, like every other
prompt. When Jev is unreachable the guardrail fails open (the call
proceeds) and the `∅ jev offline` chip appears as described above.

Identical commands are judged once per session: verdicts are cached
against the command plus the current git branch and dirty/clean state,
so switching branch or staging changes re-judges. Every judgment —
including passes and cache hits — is recorded as a `jev_judgment` event
in the session log.

The v1 guardrail gates `bash` only; write/edit follow in v1.1 once
thresholds are calibrated on real data.

### Model routing

The router picks the model that serves each turn. It is **off by default**
(the switch is in the Settings entry above): routing turns is a product
decision, not a side effect of having a key.

**The three tiers.** Every routable model belongs to one of `economico`,
`bilanciato`, `potente`. Jev answers with a tier name — never with a model
id — and moh maps the tier to a model you have actually configured. The
pool is your configured endpoints' own model lists: their vendored catalog,
or the live listing for an endpoint moh has no catalog for. Nothing is ever
invented, and if fewer than two tiers can be filled the router stays inert
(the transcript says so once).

**Which model belongs to which tier.** You can label them yourself in
`~/.moh/config`:

```json
{ "typesafe": { "routing": true, "tiers": { "my-anthropic/claude-haiku-4-5": "economico" } } }
```

Everything you do not label is ranked by its catalog price and split into
thirds — cheapest third, middle, dearest third; a two-model pool splits
cheapest and dearest. A model moh has no price for stays routable as
`bilanciato`, and a label naming a model outside the pool is ignored with
one line in the transcript, never an error.

**What Jev sees.** Only the last message you typed, truncated to 2 KiB —
plus the names of the models in each tier, so the answer can be mapped. The
rest of the conversation never leaves moh; the model that serves the turn
still receives the whole context, as always.

**When it switches.** Jev answers with a tier and a confidence. moh acts on
it only when the confidence is at least 0.60 *and* two turns in a row named
the same tier — one surprising judgment never flips your model. A switch is
shown by the ordinary `model switched` line, plus a
`jev · routing · switch to <model>` line in the transcript, and applies to
the turn that made the decision. Fallback chains are untouched: the router
names one model, and the route machinery does the rest.

**Your choice always wins.** Switch model yourself (`/model`) and the
router suspends itself for the rest of the session, with one visible line
saying so. Releasing it needs the in-session commands (`/routing`, `/model
auto`) that are not part of this version yet — turn routing off and on
again in Settings, or start a new session.

Subagents are routed too: their first message is exactly the kind of task a
router should judge, and a child's switch lands in the child's own session
log. Every judgment is recorded as one `jev_judgment` event — and only
turns that were actually judged get one, so a paused or overridden router
costs nothing.

### Still planned

- **The ★★ pack** — prompt classification, quality gate, MPM rerank,
  anti-injection, compaction cut, skill suggestion. Planned: one opt-in
  each.

Those use cases own their questions, thresholds and calibration, and they
ship in their own release; this page grows with them.
