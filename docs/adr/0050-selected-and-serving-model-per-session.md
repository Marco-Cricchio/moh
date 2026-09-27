# ADR-0050: The selected/serving model pair is per session, and a session declares what serves

Status: accepted · Date: 2026-09-27 · Related: ticket #974 · Amends ADR-0012 (the
chain stays as it is; what a session says about itself while a stop serves was
never decided) · Follows the precedent of ADR-0047 (per-session state, per-session
chrome)

## Context

A session whose provider is a `Route` carries two model references: the
**selected** one — the user's standing choice, from the configuration, `/model`,
`--provider`, or a `beforeTurn` extension — and the **serving** one, the stop that
actually serves the calls. A fallback moves the serving one down the chain and
announces it (`fallback` + `route_serving`); a recovery probe moves it back.

Before this ADR the two were treated as one value everywhere a session *stated*
which model it was working with, and the route's state was held per **runtime**
instead of per **session**:

- the system prompt's `Environment` block printed the selected reference as
  `Model:` — so during a fallback the model was told it was working with a model
  that was not serving the call;
- the TUI footer was seeded from the provider's name (the selected reference) and
  corrected itself only when a live `route_serving` passed by, and the `/model`
  header printed `active: <selected>` — both stated the selected reference as what
  was in use;
- two consumers that must behave according to the serving model read the selected
  reference instead: the image-capability probe (an image attachment became a typed
  image part from the *selected* model's declared modalities) and the compaction
  window (threshold and tail budget from the *selected* model's window, while the
  measured tokens belonged to the serving model);
- a subagent child was handed the parent's **provider object**, not a reference, so
  parent and child shared one route: serving index, per-stop failure cooldowns and
  the once-per-turn recovery flag.

Ticket #974 is the bill arriving. In the reported session the selected subscription
endpoint answered `quota_exhausted` and the automatic chain moved the session to its
first eligible stop (ADR-0012 working as designed: `fallback` + `route_serving`, and
correctly no `model_switched`). Asked why the transcript showed another model's
`thinking ·` label, the assistant quoted its own environment block and asserted the
session was running on the selected model — while every call was served by the
fallback. In the same parent, a fallback entered **inside a child** left the parent's
next call served by the fallback with no transition anywhere in the parent's log:
the parent's model had moved without the parent's session recording anything. This is
the same class of mistake ADR-0047 fixed for extension-runtime state — state and
chrome that belong to one session, held per runtime.

## Decision

**1. Two references, one session.** The **selected** reference is the user's standing
choice; it stays stable while a fallback serves. The **serving** reference is what
actually serves the calls and moves with the chain. Both are readable from the
session.

**2. One statement rule, one formatter.** Wherever a session states which model it is
working with, the pair renders as `<selected> → <serving>` when the two differ, and
as the single reference when they agree. The formatter belongs to the core; clients
do not reimplement it. The surfaces are the prompt's `Environment` block, the TUI
footer, and the `/model` header. The `/model` picker's marker stays on the selected
model: it marks what a pick would replace, it does not claim what serves. A session
whose provider is not a route (a registered id, a pre-built instance) has one
reference and states exactly that.

**3. The prompt states what serves; it does not describe the route.** The dead
`- Route:` line — populated by no production client — and its field on the prompt
context are removed. When nothing is in fallback, the block is otherwise unchanged.

**4. Route state is per session, never per runtime.** A subagent child builds its
**own** route instead of borrowing the parent's provider object. The chain rule is
unchanged (ADR-0012); what changes is where it starts: from the pair the parent is in
at spawn — the parent's selected reference becomes the child's selection, and when the
parent is serving a fallback, that reference becomes the child's initial serving
state. Serving index, failure counters and transitions are the child's from then on.

**5. Facts are inherited, state is not.** The child inherits the parent's per-stop
cooldown **deadlines**: an exhausted quota is a fact about the account, not about a
session, and a child that re-probes a stop known to be dead spends a call for
information the parent already had. Its counters and recoveries stay its own — after
an inherited deadline expires, the child re-probes its selected stop on its own.

**6. The inherited state is declared in the child's log.** A child born serving a stop
other than its selection opens its log with the existing `route_serving` chrome
(`previous` = the selection, `serving` = the inherited stop), so the child's log reads
on its own. It is not a change the user watched happen, so it raises no fallback
toast. The parent's log gains nothing for a child's transitions.

**7. Behaviour follows the serving model.** Every consumer that derives behaviour
from the model in use — image capability, the compaction window — resolves against the
serving reference. The selected reference is not "the model in use".

**8. The state is not persisted.** The serving state is a live fact of a running
session, not state on disk: a resumed session starts on its selected reference and
re-engages the chain visibly if that stop is still unavailable.

## Consequences

- `selectedModel` / `servingModel` become the pair's source of truth; the session's
  `activeModel` keeps meaning the selected reference. A reader that means "the model
  in use" reads the serving one — a rule a reviewer can check mechanically.
- The prompt's content changes only while a fallback is in play; a session whose route
  never left its selected reference assembles a byte-identical prompt, minus the
  removed `Route:` line.
- The fallback toast's ad-hoc wording (`using fallback X · selected Y`) is replaced by
  the one formatter.
- Parent and child recover independently: a stop may be re-probed in both, each
  visibly in its own log.
- Known limits, deliberate: the quota cooldown length and the once-per-turn recovery
  probe are unchanged (#974's scope note); the `route_serving` / `fallback` payloads
  and the `ProviderError` taxonomy gain nothing; the routing extension and
  `moh usage routes` keep reporting transitions exactly as before.

## Considered options

- **Fix the prompt only.** Rejected: the same `.name`-as-"the model in use" reading
  governs behaviour (image parts, compaction window), not just copy — and a session
  and its children would keep sharing one route.
- **Keep the shared route, record a child's change in the parent's log.** Rejected: it
  duplicates in one session's log what another session did, contradicting ADR-0047's
  attribution rule, and the parent's model would still move without the parent having
  decided anything.
- **Start the child from the parent's selected reference with clean state.** Rejected:
  it spends a call re-probing a stop the account is known to have exhausted, then falls
  back again inside the child, to rediscover what the parent already knew.
- **Write the pair as `<serving> (selected: <selected>)`.** Rejected in favour of the
  arrow: it names both sides in the reading order the domain uses — the standing choice
  first, what serves after it.
