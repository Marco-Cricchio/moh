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
  apiVersion: MOH_EXTENSION_API_VERSION, // "1.0" — major must match the host
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
3. Per tool call: `onToolCall` — return `{ veto: true, reason? }` to deny;
   runs before the permission gate's user-rule tiers.
4. Per event-log entry: `onEvent` — every event, appended order, including
   the `tool_call`/`tool_result` pair your veto produced. Dispatch runs on a
   serial queue, so hooks see events shortly after they are appended.
5. Per turn end: `afterTurn` — the turn outcome
   (`{ status, reason?, message? }`).
6. `onSessionEnd` — once, when the client disposes the session.

A veto outranks user permission rules and applies even in
bypass mode — extensions can only restrict, never widen. The denial
produces the same denied `tool_result` the model sees for any denial, so
the loop can react to it.

## Versioning policy

- The host speaks `MOH_EXTENSION_API_VERSION` (`"major.minor"`); the
  current major is **1**.
- **Additive-only within a major**: new hooks and context fields may be
  added; existing ones never change meaning or disappear. Deprecated APIs
  survive one full major.
- A major mismatch refuses to load (warning only, the session continues).
  A mismatch detected at hot-reload keeps the previous instance running.
- Minor gaps are fine: the host ignores capabilities newer than itself.

## Loading, lifecycle, failure

- Loading goes through `ExtensionRuntime.registerFile(file)` (dynamic,
  cache-busted import) or `register(def)` (in-memory). The runtime owns
  one-time **enable consent** (per name+version, persisted in
  `<mohHome>/extensions.json`) and **per-change npm dependency
  authorization** — say where those answers come from; with no consent
  seam and nothing stored, the load is refused.
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
