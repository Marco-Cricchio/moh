# Writing extensions

**Who this is for:** you are building a module against the
`@moh/extension` contract — you want to observe the agent loop and
restrict tool calls from inside a running moh session. If you instead want
to embed moh in your own program, read [library-usage.md](library-usage.md).

An extension is a module whose **default export** is a
`defineExtension(...)` result. The contract is published as the types-only
package `@moh/extension`; everything an extension can do goes through the
context injected into `setup(ctx)`. There is no ambient API.

## A minimal extension that runs

`no-rm-rf.mjs` — vetoes `rm -rf` commands and counts tool calls (this
exact file lives at [examples/no-rm-rf.mjs](examples/no-rm-rf.mjs) and
runs):

```ts
import { defineExtension, MOH_EXTENSION_API_VERSION } from "@moh/extension";

export default defineExtension({
  name: "no-rm-rf",
  version: "0.1.0",
  apiVersion: MOH_EXTENSION_API_VERSION, // "1.4" — major must match the host
  setup(ctx) {
    ctx.state.seen ??= 0; // durable state; carried across hot-reloads

    // Veto is the only influence an extension has: restrict, never grant.
    ctx.onToolCall(({ name, args }) => {
      if (name !== "bash") return;
      const command = String(args?.command ?? "");
      if (command.trimStart().startsWith("rm -rf")) {
        return { veto: true, reason: "no-rm-rf: refusing recursive force delete" };
      }
    });

    // Observation: every event-log entry, in order.
    ctx.onEvent(({ event }) => {
      if (event.type === "tool_call") {
        ctx.state.seen += 1;
        console.error(`[no-rm-rf] tool call #${ctx.state.seen}: ${event.name}`);
      }
    });
  },
});
```

A host loads it with `ExtensionRuntime.registerFile()` and passes the
runtime into the session — the full runnable host script is at
[examples/run-extension.ts](examples/run-extension.ts) (`bun
docs/extending/examples/run-extension.ts` from the repo root). Its core:

```ts
import { builtinTools, createSession, ExtensionRuntime, MockProvider } from "@moh/core";

const extensions = new ExtensionRuntime({ consent: () => true });
await extensions.registerFile("./no-rm-rf.mjs");

const session = createSession({
  provider: MockProvider.scripted([/* turns */]),
  cwd: process.cwd(),
  tools: builtinTools(),
  permissions: { mode: "auto-accept" },
  extensions,
});
const result = await session.send("clean up /tmp/scratch");
// -> {"type":"permission_denied","callId":"mock-0","tool":"bash","reason":"extension"}
await session.dispose();
```

## ExtensionDefinition

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | unique extension name |
| `version` | `string` | extension's own version |
| `apiVersion` | `string` | `"major.minor"`; **mandatory**, major must match the host |
| `dependencies` | `string[]` | optional npm specs; installed by the host, per-change authorization |
| `setup(ctx)` | function | receives the `ExtensionSetupContext` |

## ExtensionSetupContext

- `state: Record<string, unknown>` — per-extension key/value store,
  preserved across hot-reloads.
- `appendToPrompt(note)` — append to the trailing `extension_notes`
  system-prompt section (append-only; you can never rewrite other
  sections).
- `setPromptNote(text | null)` — set (or clear) your extension's per-turn
  note, rendered in the `turn_notes` section; see "The two prompt doors"
  below.
- Hook registration: `onSessionStart`, `onSessionEnd`, `beforeTurn`,
  `beforeModelCall`, `onToolCall`, `onToolResult`, `onCompaction`,
  `onEvent`, `afterTurn`.

## Hooks and their ordering

All hooks are additive-only and observe/influence; none can widen
permissions. Within one turn, the ordering is:

1. `onSessionStart` — once, at session start.
2. Per user send: `beforeTurn` — read-only context
   (`{ text, turnIndex, model }`), and the only hook that can influence
   *which model serves the turn*: return `{ model: "<endpoint>/<model-id>" }`
   and that model serves the turn the hook was called for. Return
   `{ confirm: { reason, onResolved? } }` to ask the user before the turn is
   sent — a modal in the TUI, a refusal where nothing can ask — and the
   `onResolved` callback hands you the answer so you can record it (below).
   It fires before the turn's provider is read and before anything is
   logged, so a turn that is never sent leaves no trace.
3. Per model call: `beforeModelCall` — read the assembled prompt
   (`{ sections, system, version }`) and messages; read-only.
4. Per tool call: `onToolCall` — return `{ veto: true, reason? }` to deny,
   or `{ ask: true, reason? }` to hand the call to the human consent flow;
   runs before the permission gate's user-rule tiers.
5. Per settled tool call: `onToolResult` — the tool's text output, before it
   is logged and before the model sees it; return `{ withhold: { reason } }`
   to replace it with a refusal (apiVersion 1.4, ADR-0034).
6. Per event-log entry: `onEvent` — every event, appended order, including
   the `tool_call`/`tool_result` pair your veto produced. Dispatch runs on a
   serial queue, so hooks see events shortly after they are appended.
7. Per turn end: `afterTurn` — the turn outcome
   (`{ status, reason?, message? }`).
8. `onSessionEnd` — once, when the client disposes the session.

A veto outranks user permission rules and applies even in
yolo mode — extensions can only restrict, never widen. The denial
produces the same denied `tool_result` the model sees for any denial, so
the loop can react to it.

## Choosing the model of a turn

`beforeTurn` is the turn-start decision point (apiVersion 1.2). It fires
once per user send — not per model call, and not for the follow-up calls a
turn makes after tools — and it is the one place where an extension can
name the model that serves the current turn:

```ts
ctx.beforeTurn(({ text, turnIndex, model }) => {
  if (shouldUseCheapModel(text)) return { model: "my-anthropic/claude-haiku-4-5" };
});
```

- The ref resolves exactly like the manual `/model` switch, against the
  same registry and endpoint profiles: you select among models the session
  can already reach, and a ref it cannot resolve is **ignored** — one
  visible `extension_failed { reason: "invalid_model" }`, the turn proceeds
  on the active model. Never a turn error, never a silent fallback to some
  other model.
- A resolved ref appends the ordinary `model_switched` chrome; a ref equal
  to the active model is a silent no-op.
- The first hook returning `model` wins, in registration order (the same
  rule as `veto`). A hook that throws is fail-open: one
  `extension_failed { reason: "hook" }` and the turn proceeds.
- Subagent children get the hook too (a child's switch lands in the child's
  own log), and never for their in-turn follow-up calls.

## Receiving commands from the client

An extension can keep session state (a streak, a cache, an override flag).
apiVersion 1.3 adds the other half: a client can **command** a running
extension, by name, through the session API.

```ts
// client side (the TUI's /routing does exactly this)
session.setExtensionState("my-extension", { cmd: "off" });

// extension side
ctx.onEvent(({ event }) => {
  if (event.type !== "extension_control") return;   // always yours when it arrives
  if (event.payload.cmd === "off") paused = true;
});
```

- **Targeted delivery.** The event reaches the addressed extension's
  `onEvent` hooks and nobody else's — two extensions listening on `onEvent`
  never see each other's commands.
- **Opaque payload.** The core carries a JSON-serializable record and never
  interprets it: `{ cmd: "off" }` and `{ cmd: "auto" }` mean whatever you
  decide. The resulting `extension_control` log entry keeps the request, so
  a replayed session still explains the state your extension ended up in.
- **Chrome, not context.** It is never fed to the model and never a turn
  error, and it cannot grant anything — a command can only make you *more*
  restrictive. The core renderer shows one dim line (`<extension> · <cmd>`).
- **You may never be commanded.** An older runtime does not know the event,
  and a client may not offer the command at all: design the extension so it
  works with the default state and treats a command as an override of it.
- Naming an extension that is not registered is not an error: the event is
  logged and delivered to nobody.

## Asking instead of vetoing

A hook has a third position between saying nothing and killing the call: it
can hand the call to the human consent flow that already exists (in the TUI,
the permission prompt). Return `{ ask: true, reason }` and the user decides.
An ask is deliberately **not** a grant: it never writes a permission rule,
and the prompt it raises offers `y`/`n` only — no "always", because a filter
disarmed by its own false positive protects nobody.

```ts
ctx.onToolCall(({ name, args }) => {
  if (name !== "bash") return;
  const judgment = judge(String(args?.command ?? "")); // your logic
  if (judgment === "unsafe") return { veto: true, reason: "guard: refusing this command" };
  if (judgment === "unclear") return { ask: true, reason: "guard: confirm this command" };
});
```

Precedence and modes are the gate's business, not yours — this is what it
does with your answer:

| Situation | Outcome |
| --- | --- |
| hook returns `veto` | denied — beats user rules, defaults, auto-accept and yolo |
| hook returns `veto` and `ask` | contradiction, and `veto` wins |
| an explicit user `deny` rule | the ask never prompts: the call is refused |
| an explicit user `allow` rule | does not suppress the ask (judging what the rules already allow is the point) |
| mode `auto-accept` | the ask still prompts — it is the only filter in that mode |
| mode `yolo` | the ask is ignored and the call proceeds; use `veto` for anything lethal |
| headless (no consent seam) | the ask degrades to a denial, like any other ask |
| several extensions or hooks | the first decision wins, in registration order |

Your `reason` becomes the prompt's label. In the log the ask stays the
gate's ordinary consent trail — `permission_requested` with
`reason: "extension"`, then the `permission_granted`/`permission_denied`
pair — so replay and the transcript render it like any other prompt.

## Asking the user before a turn

`beforeTurn`'s `confirm` is the pre-send question (apiVersion 1.4, ADR-0033
§4). You return the copy (`reason`), the client renders it, and the answer
comes back through `onResolved`:

```ts
ctx.beforeTurn(({ text }) => {
  const shot = myJudge(text);                      // your logic, your copy
  if (!shot.risky) return;
  return {
    confirm: {
      reason: `possible injection (${shot.probability.toFixed(2)})`,
      onResolved: (outcome) => {
        // "send" | "cancel" | "refuse" — record what happened.
        record(shot, outcome);
      },
    },
  };
});
```

- **The answer is only "send" or "not send".** A TUI cancel means the turn
  never happened: nothing about a user message is logged, and the text goes
  back to the composer. Where nothing can ask (headless), the turn is
  refused. Either way the answer reaches `onResolved` as `cancel` or, for a
  client that cannot ask, `refuse`.
- **Record it yourself.** A cancelled turn leaves no `user_message` in the
  log, so your own entry (`ctx.appendEvent`, typically from inside
  `onResolved`) is the only trace that the message was ever typed. The
  callback is called exactly once, and a throw inside it is swallowed.
- **A confirmation is a question, never a grant.** It cannot widen a
  permission, write a rule, or make an unpermitted tool call succeed. And a
  `model` you return in the same hook is discarded when the user cancels:
  nothing was switched for a turn that never ran.
- **First ask wins**, in registration order, like every other hook
  decision; a hook that throws is fail-open (the turn proceeds, unnasked).

## Inspecting a tool result before the model sees it

`onToolResult` (apiVersion 1.4, ADR-0034) is the post-execution seam: the
tool's output, the moment before it enters the conversation. It is
registered **per tool name** — the scope is explicit, and the core
dispatches only those:

```ts
ctx.onToolResult(["fetch", "browser"], ({ name, output }) => {
  if (isHostile(output)) return { withhold: { reason: "possible injection (0.98)" } };
});
```

- **One outcome: `withhold`.** You may replace a result with a
  refusal-shaped text; you may not rewrite, truncate or redact one in place
  (a half-edited result is a corrupted one). Failures cannot be turned into
  successes, and permissions are out of reach.
- **The withheld text is what the log holds.** The hook runs before the
  `tool_result` event and before the feedback part the model receives, so
  the log, the transcript and the next model call all agree. Replay, resume
  and fork rebuild from that same event.
- **The refusal names you.** Your `reason` is rendered as
  `external content withheld by <extension>: <reason>`, and the model can
  read it — tell it *why*, and it will explain the block to the user
  instead of fetching the same page again.
- **Text results only.** A result carrying an image (a browser screenshot)
  is never offered: an image is not judgeable text, and withholding a
  screenshot the model explicitly asked for would break the calling turn.
- **Every hook sees it, the first withhold wins** (deterministic by
  registration order) — unlike `onToolCall` and `beforeTurn`, where the
  *decision* is exclusive. A hook that throws, or one that returns a
  reason-less `withhold`, is fail-open: one `extension_failed` and the
  original result proceeds.

## Shaping what compaction summarizes

`onCompaction` (apiVersion 1.4, ADR-0035) is the compaction-time seam: when
the compaction runner covers a span (auto trigger or forced `/compact`), it
splits the covered turns into **sections** — one per user turn's *body* —
and hands you the list before the summary transcript is rendered:

```ts
ctx.onCompaction(({ sections, approxTokens }) => {
  // sections: [{ id, kind: "assistant" | "tool_result" | "tool_call",
  //              bytes, preview (~200 chars) }]
  return { drop: sections.filter(isSettledWork).map((s) => s.id) };
});
```

- **You may only remove.** The return value names ids to exclude from the
  summarizer's input; you cannot add, rewrite, reorder, or touch the
  summarizer's output, the live conversation, memory, or the event log —
  nothing is deleted from the log, ever.
- **What you never see cannot be cut.** User messages and chrome events are
  structurally absent from `sections`: they are the conversation's spine,
  and no judgment of yours can drop them. A `drop` id the core did not offer
  is ignored with a visible `extension_failed { reason: "unknown_section" }`.
- **The core keeps a floor.** At least 60% of the offered text survives no
  matter what you return: if your drops exceed the budget, the largest cuts
  keep their claim and the rest are restored, with one visible
  `extension_failed { reason: "section_floor" }` and `keptByFloor: true`
  stamped on the compaction marker. A catastrophic judgment is a bounded
  event, not an emptied conversation.
- **You learn what was actually applied.** Return an `onApplied` callback
  and the core calls it exactly once with the post-floor cut
  (`{ keptByFloor, bytesAfter }`) before the transcript renders — the
  place to record your judgment's outcome. A throwing `onApplied` is
  swallowed: observability never breaks the compaction it describes.
- **Fail-open, always.** A hook that throws, or that does not answer
  within the hook timeout (5 s for the whole dispatch), contributes no
  drops: compaction proceeds exactly as it would without you, with one
  `extension_failed`. The cut is an optimization;
  its absence changes a summary's size and nothing else.
- **The verbatim tail is out of reach.** `tailTurns` (default 10) is outside
  the covered span by construction: recent turns are never summarized, so
  never cut.

## Recording events and publishing a status

Two observation-only seams in `setup(ctx)` let an extension leave a trace
without touching permissions or the model's context (apiVersion 1.1):

- `ctx.appendEvent({ name, payload? })` records one `extension_event` in the
  session log. The runtime stamps the emitter: you never name yourself, and
  you cannot impersonate another extension.

```ts
ctx.appendEvent({ name: "judgment", payload: { decision: "ask", score: 0.42 } });
// -> { type: "extension_event", extension: "my-extension", name: "judgment", payload: {…} }
```

  The payload must be JSON-serializable and at most **8 KiB** once
  serialized. An oversized, cyclic or otherwise unserializable payload is
  dropped — never truncated — and reported as a visible
  `extension_failed { reason: "invalid_event" }`. Volume is capped at **50
  events per extension per turn**: the 51st and later are dropped, with one
  `extension_failed { reason: "event_cap" }` for that turn. Keys whose
  normalized form is exactly `apikey`, `apitoken`, `accesstoken`,
  `refreshtoken`, `token`, `secret`, `clientsecret`, `password`, `passwd`,
  `authorization`, `credentials`, `privatekey` or `sessionkey` have their
  value replaced with `"[redacted]"`, recursively to depth 6 — a safety net,
  not a licence: never put a credential in a payload. `extension_event` is
  chrome: never a turn error, never fed to the model, rendered as one dim
  transcript line (an unknown `name` renders as the bare name).

- `ctx.setStatus(text | null)` publishes this extension's footer status;
  `null` clears it. One status per extension, replaced on every call, and
  **ephemeral**: it is never written to the log and is cleared at session end
  and on hot-reload (a reloaded instance re-publishes from `setup`). The TUI
  renders one chip per published status in the footer status row; a headless
  client writes one stderr line when a new text is first published and never
  lets it affect the exit code.

Reach for `setStatus` for a statement about *now* ("the upstream service is
down, I recovered") and `appendEvent` for anything durable you want in
replay.

## The two prompt doors (durable note vs per-turn hint)

Two context methods put your extension's words in the system prompt, and
choosing between them is the whole decision:

- **`ctx.appendToPrompt(note)`** appends to the trailing `extension_notes`
  section. The note is **durable**: it is part of your extension's
  identity, written at `setup` time, read at every prompt assembly, and
  there is no clear or replace — it stays for the session. This is the
  door for identity-level text ("this session is driven by the Foo
  service").
- **`ctx.setPromptNote(text | null)` (ADR-0036)** sets your extension's
  note for the **current turn**. One note per extension, replacing: a
  second call overwrites, `null` removes. The note is **ephemeral** — the
  core clears every turn note at the start of the next turn (before the
  `beforeTurn` hooks run), so an extension that wants a note writes it
  every turn, and an extension that stops writing simply stops being
  represented. It renders in the dedicated `turn_notes` section, after the
  project's instruction documents and before the conversation context —
  subordinate to the project's own rules, by construction. An oversized
  note is truncated with a marker; a note set mid-turn is never
  retroactively injected into calls already sent.

`setPromptNote` is observation and suggestion only: the note reaches the
model, and the model may ignore it. It is never a permission, and it
cannot touch the system prompt, the project instructions, or another
extension's note.

## Versioning policy

- The host speaks `MOH_EXTENSION_API_VERSION` (`"major.minor"`); the
  current version is **1.5** (1.1 added `ask` and the two observation
  seams; 1.2 added `beforeTurn`; 1.3 added the `extension_control`
  command channel; 1.4 added `onToolResult`, `confirm.onResolved` and
  `onCompaction`; 1.5 added `setPromptNote`).
- **Additive-only within a major**: new hooks and context fields may be
  added; existing ones never change meaning or disappear. Deprecated APIs
  survive one full major.
- A major mismatch refuses the load: the session continues with an
  `extension_failed` event (a warning, never a session abort). A mismatch
  detected at hot-reload keeps the previous instance running.
- Minor gaps are fine, in both directions: the host ignores capabilities
  newer than itself, and an older runtime ignores what it does not know —
  an unknown outcome key (`ask` on a 1.0 runtime) is dropped and the call
  proceeds, an unknown context method is simply absent. Fail-open, never an
  error.

## Loading, lifecycle, failure

- Loading goes through `ExtensionRuntime.registerFile(file)` (dynamic,
  cache-busted import) or `register(def)` (in-memory). For file modules,
  the runtime binds enable consent to the resolved absolute path and a SHA-256
  hash of its contents, persisted in `<mohHome>/extensions.json`. Editing a
  file or loading another file that claims the same name requires consent
  again; an unchanged file loads silently. The approved npm dependency list
  is bound to that same content identity and is authorized again after a
  changed module requests dependencies. Both are host-supplied seams; with
  no consent seam and nothing stored, the load is refused.
- Hot-reload: registered files are watched; on change the module is
  re-imported and `setup()` re-runs with the previous `ctx.state` seeded
  in. A failed reload keeps the previous instance running (warning only).
- Failure model: a failed load is a warning, never a session abort. The
  runtime records `extension_loaded` / `extension_failed` events and the
  session continues without the extension. An extension whose dispatch
  throws is marked failed terminally (`extension_failed`) and never
  re-dispatched.
- No sandboxing in v1 — consent plus veto-only hooks is the trust model;
  npm dependency installs require per-change authorization.
