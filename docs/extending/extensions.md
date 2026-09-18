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
  apiVersion: MOH_EXTENSION_API_VERSION, // "1.1" — major must match the host
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
- Hook registration: `onSessionStart`, `onSessionEnd`,
  `beforeModelCall`, `onToolCall`, `onEvent`, `afterTurn`.

## Hooks and their ordering

All hooks are additive-only and observe/influence; none can widen
permissions. Within one turn, the ordering is:

1. `onSessionStart` — once, at session start.
2. Per model call: `beforeModelCall` — read the assembled prompt
   (`{ sections, system, version }`) and messages; read-only.
3. Per tool call: `onToolCall` — return `{ veto: true, reason? }` to deny,
   or `{ ask: true, reason? }` to hand the call to the human consent flow;
   runs before the permission gate's user-rule tiers.
4. Per event-log entry: `onEvent` — every event, appended order, including
   the `tool_call`/`tool_result` pair your veto produced. Dispatch runs on a
   serial queue, so hooks see events shortly after they are appended.
5. Per turn end: `afterTurn` — the turn outcome
   (`{ status, reason?, message? }`).
6. `onSessionEnd` — once, when the client disposes the session.

A veto outranks user permission rules and applies even in
yolo mode — extensions can only restrict, never widen. The denial
produces the same denied `tool_result` the model sees for any denial, so
the loop can react to it.

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

## Versioning policy

- The host speaks `MOH_EXTENSION_API_VERSION` (`"major.minor"`); the
  current version is **1.1**.
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
