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
  see below).
- **Anti-injection** — the opt-in for the prompt-injection check (off by
  default; see below). It is the one use case that sends the text you
  typed, so it is never on unless you turned it on.
- **Classification** — the opt-*out* for prompt classification (on by
  default; see below). Turning it off also stops the project-map gate that
  depends on it.
- **Status** — a read-only row: `active (key …abcd, timeout 2500ms)` or
  `inactive`.
- **Remove** — clears the key; the bundled extension is then not registered
  at all, from the next session on.

There is no first-run wizard: **a stored key is the state**. Enter the key
from the panel — that is where it is validated and masked, so hand-editing
the configuration file is not a supported way to activate Jev. The use-case
opt-ins are changed the same way, and all of them are read when a session
starts: a session already open keeps the settings it was assembled with.

**These rows are the persistent switches.** What they write applies from the
next session on; changing a use case inside a session you already have open
is what `/jev` is for (see [Controlling the use cases](#controlling-the-use-cases)).
The same flags are reachable from a shell, for a machine you are only
setting up: `moh jev routing on`, `moh jev classification off` and so on —
`moh jev --help` lists the names, and every one of them writes
`~/.moh/config` exactly like the panel.

The key lives in `~/.moh/config` (the `typesafe` block, key `apiKey`) —
the user configuration, never moh.json: a cloned project must not be able
to activate an account on your behalf. The per-call timeout
(`typesafe.timeoutMs`, default 2500 ms) is configuration only — there is no
timeout field in the panel. The Config reference page lists the block.

## What leaves your machine

The disclosure shown next to the Settings entry, verbatim:

_judgments send the command, working directory and git branch/state to
TypeSafe (US). TypeSafe declares no training on inputs._

With anti-injection on, the disclosure says more, because that use case
sends more: your message text (up to 4 KiB) and the text of every web
result (up to 8 KiB). Nothing else about a turn ever leaves moh.

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
  jev             active (key …abcd, timeout 2500ms)
  routing         off
  injection       off
  quality gate    off
  classification  on
  rerank          off
  skills          off

$ moh jev status --json
{"active":true,"keyHint":"…abcd","timeoutMs":2500,"routing":false,"injection":false,"lint":false,"classification":true,"rerank":false,"skills":false}
```

The command reads your configuration and never calls TypeSafe — the key was
validated when you saved it. It exits 0 whether Jev is active or not
(information, not verification) and, when Jev is inactive, prints the way
back to the Settings panel. Only a malformed `typesafe` section is an error
(exit 2), like every other broken config section.

### Changing a flag from the shell

```
$ moh jev skills on
skill suggestion: on · from your next session (the config in ~/.moh/config)
$ moh jev classification off
prompt classification: off · from your next session (the config in ~/.moh/config)
```

The usable names are `routing`, `injection`, `classification`, `lint`,
`rerank` and `skills`. `guardrail` is not one of them, and the command says
why instead of pretending it is a typo: the guardrail has no configuration
flag at all — a stored key is what turns it on — so it can only be switched
off for a single session, from the `/jev` modal. An unknown name, a missing
action (`moh jev routing` alone) or a malformed `typesafe` section is a usage
error: exit 2, a message on stderr, and your file left exactly as it was.
A write never makes a call to TypeSafe, and it never touches the key or any
other section of the config.

## Controlling the use cases

There are two switches per use case, and they are not the same kind of
thing.

- **The configuration** — the Settings entry (`Jev (TypeSafe)`), the
  `typesafe` block of `~/.moh/config`, and `moh jev <use case> on|off` from
  the shell. It is what a **new session starts in**. Nothing else changes it.
- **The session** — a change made while a session is open, from the chat.
  It applies to that session only, from the next turn on, and it is gone
  when the session is closed, reloaded or resumed: the config decides again.

The seven use cases are `guardrail`, `routing`, `classification`,
`injection`, `lint`, `rerank` and `skills`. Turning one **off** in the
session stops it spending calls immediately; turning one **on** starts it
from the next turn *even when the configuration says off* — which is how you
try an opt-in use case on a single session without writing anything down.
Every change leaves one line in the transcript saying exactly that:

```
jev · injection · on for this session — the config still says off
jev · routing · off for this session — the config still says on
```

so a session you resume still shows why a use case is quiet while the
configuration says otherwise. Routing is the one use case whose session
state has more than on/off (a manual model switch suspends it, and `auto`
hands it back); its commands are the `/routing` ones above, and it is shown
in its own words when paused.

### The `/jev` modal

`/jev` opens the session switchboard: one row per use case with the state it
is in **right now**, and the state the configuration names beside it, because
they are two different things.

```
  › guardrail       ● on       config on
    routing         ❙❙ paused   config on · suspended — you picked the model by hand (auto hands it back)
    classification  ● on       config on
    injection       ● on       config off
                  on for this session — the config still says off
    lint            ○ off      config off
    rerank          ○ off      config off
    skills          — inert    config off · not available in this session
```

`↑`/`↓` move, `enter` (or space) flips the selected row, `r` re-reads the
state, `esc` closes. The four states are: `on` (judging now), `off` (not
judging), `paused` (routing only: on, but suspended by a manual model switch
you made — flip it to hand routing back) and `inert` (this session cannot run
it at all). A flip sends the command to the extension and nothing else: no
file is written, and the line under the row tells you what the config still
says, so a session you resume tomorrow starts from the configuration again.

A refused flip says so in the same place — the guardrail in yolo, or a use
case this session has no use for. With no Jev key at all there is no
extension to command, so the modal opens on the way back to Settings
(`ctrl+s` → Jev (TypeSafe) → API key) instead of an error or an invented
`off`.

Two rules are worth stating plainly:

- **The guardrail cannot be switched off in yolo.** In that mode the
  guardrail is narrowed to the lethal checks and it stays that way: the
  command is refused with a visible line rather than obeyed. Outside yolo
  the session switch works like every other one.
- **A use case the session cannot run is not a use case you can switch on.**
  If a session has nothing to give it — no model pool to route between, no
  skill roster to suggest from, no project root to diff — it is *inert*, and
  a command for it is refused with a line saying so. Nothing is silently
  ignored, and no judgment is ever faked.

## Use cases

Eight things run today, seven of them switchable from `/jev`: the bash
guardrail, the model router, the prompt classification, the anti-injection
check, the quality gate, the seed rerank and the skill suggestion — plus the
compaction cut guide, which has no opt-in to switch and always runs when
compaction does.

### What vibe mode shows

The transcript has two modes (`dev` and `vibe`), and the full Jev audit
trail belongs to `dev`. In **vibe** mode — the plain-language projection —
most Jev records drop from the transcript so a Jev-heavy turn does not
read as a wall of `◈ jev · …` lines. What survives:

- the **anti-injection** verdicts that changed what you saw or sent
  (`warn`, `withheld`, `cancelled`, `refused-headless`, `sent anyway`);
- the **guardrail** `ask` and `deny` lines (a `pass` never shows, in
  either mode);
- a real routing **`switch to <model>`** — not a `stay`, not the router's
  notices (`unpriced`, `ignored-label`, `inert`, `mismatch`);
- a quality-gate **`correct`** (a correction turn is running) — not a
  `pass`;
- the **skill suggestion** when a skill was actually suggested;
- your own use-case **control lines** (`… on for this session`, and every
  refusal) — your command echoing back.

Everything filtered out stays in the session log: this is a projection
option only, and `dev` mode renders the full audit trail exactly as
before.

### Bash guardrail

The first use case is the **bash guardrail**: every `bash` tool call is
judged by Jev with one call — four questions (`destructive`, `in_scope`,
`exfiltration`, `risk_level`) — before your permission rules are even
consulted. The verdicts:

- **pass** — nothing changes; your rules and modes decide as always. A
  pass leaves no line in the transcript: nothing happened to you. The
  judgment is still in the session log, with its verdict.
- **ask** (either probability in 0.40–0.75, or risk in 0.75–1.5) — the
  call reaches the ordinary permission prompt even in auto-accept mode,
  marked **Jev: caso incerto (…)** with the key probability. The transcript
  shows one line — `jev · guardrail · ask (destructive 0.42)` — naming the
  probability the verdict was based on. The prompt
  offers yes/no only: a guardrail false positive must never write an
  "always" rule that disarms the filter.
- **deny** — the call is vetoed and the model receives the reason plus an
  actionable suggestion ("scope the path to /tmp and re-run"); the
  transcript shows one `jev · guardrail · deny (…)` line with the key
  probability.

In **yolo** mode only the lethal checks run (destructive, exfiltration):
they can still deny, but Jev never prompts — yolo means zero prompts.
In headless (`moh run`) an "ask" degrades to a denial, like every other
prompt. When Jev is unreachable the guardrail fails open (the call
proceeds) and the `∅ jev offline` chip appears as described above.

Identical commands are judged once per session: verdicts are cached
against the command plus the current git branch and dirty/clean state,
so switching branch or staging changes re-judges. Every judgment —
including passes and cache hits — is recorded as a `jev_judgment` event
in the session log, each naming its verdict (`decision`) and, on an ask
or deny, the key probability it was based on. A cache hit carries
`cached: true` and repeats the already-decided verdict; it has no
`model`, `latencyMs`, `usage` or `answers` fields, because a cached
verdict involves no model call and nothing fabricated is ever written.
Only the notable outcomes
reach the transcript: an ask and a deny get one line each, a pass gets
none.

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

**Controlling it: `/routing`.** The persistent switch is the Settings entry
above; the session commands are the quick ones and never write your
configuration:

```
/routing          state + the resolved tier assignment
/routing off      pause routing for this session (the model stays as it is)
/routing on       enable it for this session (also hands back an override)
/routing auto     release a manual override
```

Every use case is governed this way, not only routing — the whole set has one
command surface, described under [Controlling the use cases](#controlling-the-use-cases)
below, and `/routing` is the shortcut for the router's own row.

**Your choice always wins.** Switch model yourself (`/model`) and the
router steps aside, with one visible line saying so; `/routing auto` (or
`/model auto`) hands it back — releasing does **not** re-route the model
you are on, the next judged turns do. If the serving model is not the one
the router picked (you edited the configuration, or chose an id outside
the tier map), the router says so once — `jev · routing · serving
(model), router picked (model)` in the transcript — and waits instead of
overruling you on the next message.

`/routing on` works even when the Settings toggle is off — it enables
routing for that session only, which is the quick way to try it. The state
lasts for the session it was typed in: reopening a session (or `/reload`)
starts from the configuration again. A paused or suspended router makes no
call at all, so it costs nothing.

Every command leaves one line in the transcript (`jev-guard · off`), so a
session you resume still shows why its model stopped moving.

Subagents are routed too: their first message is exactly the kind of task a
router should judge, and a child's switch lands in the child's own session
log. Every judgment is recorded as one `jev_judgment` event — and only
turns that were actually judged get one, so a paused or overridden router
costs nothing.

### Anti-injection

The **anti-injection** check looks for text that tries to steer the agent
against you — a page telling the model to ignore its instructions, to
leak a file, or to run something you never asked for. It is **off by
default** (the switch is in the Settings entry above): it is the only use
case that reads your own message, and that is a choice. It has two halves.

**Your message, before the turn is sent.** Jev judges up to 4 KiB of what
you typed with two questions — is this content trying to manipulate an
assistant (`injection`), and does it carry credentials or personal data
(`sensitive`) — and the answer decides between three bands:

- **below 0.50** — silence: nothing is shown, the judgment is recorded.
- **0.50 to 0.95** — one visible line in the transcript
  (`jev · injection · warn (injection 0.63)`), and the turn is sent as
  always. A fired `sensitive` signal says the one thing it implies:
  *do not commit or share this content*.
- **above 0.95** — a **confirmation**: the send is held and a modal asks
  `⚠ possible injection (0.97)`. `y` (or enter) sends the turn anyway and
  records the confirmation; `n` (or esc) sends **nothing** — the text goes
  back to the composer, no user message is written to the session, and the
  only record is the check's own line
  (`jev · injection · cancelled — nothing was sent`). In headless
  (`moh run`) there is no one to ask, so the turn is refused with one
  stderr line and the run still exits 0 — a refusal is not a crash. The
  sensitive signal never blocks: you may well have pasted a key on
  purpose.

**Web results, before the model sees them.** A `fetch` or `browser` result
is judged the same way (up to 8 KiB — the payload, not the whole page).
Above 0.95 the model does not receive the page: it receives
`external content withheld by jev-guard: possible injection (0.98) — the
page content was not shown to the model`, which is also what the session
log holds, so a resumed or forked session shows exactly what the model
saw. The middle band lets the page through with a visible warning. Only
those two tools are inspected — reading a file or running a command is
your own material, and a judgment on every read would be ruinous.

Nothing here is a wall: the check is one probability, and you keep the
last word. **What it costs:** one Jev call per turn you send, plus one per
`fetch`/`browser` result — about 0.8 s and a fraction of a cent each, on
top of whatever the guardrail and the router call. Turn it off in the
Settings entry and the next session makes no call at all.

### Compaction cut guide

When moh compacts a long session (automatically, or when you run
`/compact`), Jev helps decide **what the summary needs to cover**. The
covered part of the session is split into one section per turn's work —
your own messages and moh's decisions are never sections and are never
shown to Jev — and each section's short preview (a couple of hundred
characters, never the full text) is judged with one question: *can this
be safely dropped from the summary without losing information the
conversation will still need?*

A section judged settled (probability above 0.70) is left out of the
summary's input, which makes summaries smaller and sharper. Three
guarantees ride with it:

- **Your words survive.** User messages, decisions and chrome are
  structurally outside the cut — not protected by a rule, absent by
  design.
- **A floor holds.** At least 60% of the judged text survives no matter
  what: even a catastrophic judgment can only shrink the summary input so
  far, and a reduced cut is announced in the transcript.
- **Fail-open.** If Jev is unreachable, compaction runs exactly as it
  would without Jev. The cut is an optimization, never a gate.

Nothing is deleted from the session: the log stays integral, and the tail
of recent turns is verbatim as always. One judgment per section is
recorded as a `jev_judgment` event, plus one aggregate record per
compaction carrying the offered sections, the dropped ids, whether the
floor was applied, and the byte sizes before and after.

### Prompt classification

Every turn you send, Jev classifies it on two questions: what **kind of
task** it is (`question`, `bugfix`, `feature`, `refactoring` or
`analysis`) and whether answering it well **requires this project's code**
(`codebase_oriented`). Jev sees the same slice the router sees — the last
message you typed, up to 2 KiB. The classification is **on by default**
and drives two small things:

- **A task-type hint.** A fixed one-liner per type (a bugfix turn is
  reminded to reproduce the failure before changing code; an analysis turn
  to answer without modifying files) is placed in the prompt's
  *Turn notes* section — after your project's own instruction documents,
  so it can never outrank them. The hint is applied only when the
  classification's confidence is at least 0.60, and it lives for exactly
  one turn.
- **The project-map gate.** When the classification says the turn almost
  certainly does not need your code (`codebase_oriented` below 0.50), moh
  skips the per-turn project-map orientation for that turn. Only the
  per-turn plan is gated: the projection itself, the `mpm_query` tool and
  the manual map commands work exactly as before, and the model can still
  query the map itself. A turn the classifier has no confident opinion on
  behaves exactly as without Jev.

If **model routing** is also on, the classification rides the router's
request — one call per turn serves both. On its own it costs one call per
turn. Turn it off with `typesafe.classification: false` in the user
configuration; every judgment is recorded as one `jev_judgment` event
(`useCase: "classification"`) showing the type, the confidence, whether a
hint was applied and whether the map was gated.

### Quality gate

At the **end of a task**, Jev reviews the work against your project's own
rules. When a task ends (the model stopped, the turn is done — never on a
cancel) and the task actually changed files, moh collects:

- **The conventions the project itself ships** — `AGENTS.md`, `CLAUDE.md`,
  `CONTRIBUTING.md`, `STYLE.md`, `CONVENTIONS.md`, `.cursorrules` and the
  same names under `.github/` and `docs/` (plus everything under
  `.cursor/rules/`). Up to 6 files, 16 KiB total. **A project with none of
  these documents gets no quality gate at all** — moh never invents rules
  your repo does not state.
- **The diff of the files the task changed** (against where the task
  started), capped at 32 KiB. Only **repository changes** are judged:
  a write the tool refused — for example a path outside the project
  root — contributes nothing, a file outside the work tree is never
  diffed even if it exists on disk, and a diff that touches no
  repository code (documentation-only changes) is not scored with the
  code questions — the gate stays silent.

Three yes/no judgments are made over that state: does the change follow
the stated conventions; does it handle failure paths rather than assuming
success; is it complete, with nothing left stubbed. Any answer below 0.40
is a **finding**, and on a finding moh automatically hands the model a
correction request — in plain words, naming the flagged areas **and the
files that were judged** — and lets
it run a normal turn with tools to fix the work. The corrected state is
then judged once more. **The gate stops after two correction cycles,
whatever the verdict**; a correction turn is marked in the transcript so
you can always tell it was machine-triggered, and it can never loop
forever.

Fail-open as everywhere: if Jev is unreachable, the gate stays silent and
the task simply ends as it would without Jev. Every evaluation is
recorded as one `jev_judgment` event (`useCase: "lint"`) with the three
probabilities, the findings and the cycle number.

### Seed rerank

When the [project map](project-map.md) builds its per-turn **orientation
plan**, a seed that resolves to more than five files is normally discarded —
the plan honestly says nothing rather than guessing. With the seed rerank
opt-in, that discard becomes a ranking: moh sends TypeSafe **one fan-out
request** — the task text plus one yes/no question per candidate file (its
path, its top symbols and why it was in the set), capped at 30 candidates —
and keeps the top five answers above 0.50. Those become the plan, each
entry marked `(reranked)` in the transcript so you can see why an
over-threshold task produced one. If fewer than two candidates clear the
bar, there is **no plan** — the same honest answer as without Jev. A plan
that already fits under the threshold never consults Jev.

Off by default (`typesafe.rerank`, or the **Seed rerank** entry in Settings
→ Jev). What leaves your machine, only when an over-threshold seed set
appears: the task text and the candidate metadata above — never file
contents. A failure degrades to no plan, never a broken turn.

### Skill suggestion

Every turn you send, Jev suggests **at most one skill** — following the
TypeSafe cookbook's two-call pattern. It is **off by default** (the
**Skill suggestion** entry in Settings → Jev, `typesafe.skills`), because
it sends your message plus the whole skill roster to TypeSafe, twice per
judged turn.

**Call one** ranks your entire roster — every skill moh discovered from
`~/.moh/skills` and the project's `.moh/skills` (project wins on clash),
exactly the list the skills prompt index is built from — with one yes/no
question per skill, plus one gate question: *does this turn need a skill
at all?* A gate below 0.60 ends the check there: one call, no suggestion.

**Call two** re-reads the top three ranked skills with their full
descriptions and asks, per skill, *is this genuinely the right one to
load?* The strongest answer at or above 0.60 wins; a washout below the
floor suggests nothing. **At most one** skill is ever suggested, and it
reaches the model as a single line in the prompt's *Turn notes* section —
the same subordinate place the task-type hint lives, never the roster
itself. The model may ignore it; you may also just say which skill to use.

No skills installed means no call at all. Fail-open as everywhere: an
unreachable Jev yields no suggestion and an unchanged turn. Each of the
two calls is recorded as one `jev_skill_suggest` event carrying the
probabilities, the finalists and — on a hit — the winner.

Those use cases own their questions, thresholds and calibration, and they
ship in their own release; this page grows with them.
