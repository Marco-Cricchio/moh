# Extension API reference

The extension contract is published as the types-only package `@moh/extension`. Everything an extension can do goes through the context injected into `setup(ctx)`; there is no ambient API.

## defineExtension

An extension is a module whose **default export** is a `defineExtension(...)` result:

```ts
import { defineExtension, MOH_EXTENSION_API_VERSION } from "@moh/extension";

export default defineExtension({
  name: "my-extension",
  version: "0.1.0",
  apiVersion: MOH_EXTENSION_API_VERSION, // or a literal like "1.0"
  dependencies: ["zod@^4"], // npm specs; installed by moh, per-change authorization
  setup(ctx) {
    ctx.onEvent(({ event }) => {
      if (event.type === "tool_call") console.error(`tool: ${event.name}`);
    });
  },
});
```

## ExtensionDefinition

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | unique extension name |
| `version` | `string` | extension's own version |
| `apiVersion` | `string` | `"major.minor"`; **major must match the host** |
| `dependencies` | `string[]` | optional npm specs installed by moh |
| `setup(ctx)` | function | receives the `ExtensionSetupContext` |

## ExtensionSetupContext

- `state: Record<string, unknown>` — per-extension key/value store, preserved across hot-reloads.
- `appendToPrompt(note: string)` — append to the trailing `extension_notes` system-prompt section (append-only; you can never rewrite other sections).
- Hook registration: `onSessionStart`, `onSessionEnd`, `beforeModelCall`, `onToolCall`, `onEvent`, `afterTurn`.

## Hooks (v1)

All hooks are additive-only and observe/influence; none can widen permissions.

| Hook | Context | May do |
|---|---|---|
| `onSessionStart` | `{ startedAt }` | observe |
| `onSessionEnd` | `{ reason }` | observe |
| `beforeModelCall` | `{ prompt: { sections, system, version }, messages }` | read the assembled prompt (read-only) |
| `onToolCall` | `{ callId, name, args }` | return `{ veto: true, reason? }` to deny the call — **veto only, never grant** |
| `onEvent` | `{ event }` | observe every event-log entry |
| `afterTurn` | `{ result: { status, reason?, message? } }` | observe turn outcome |

A veto outranks user permission rules and produces the same denied `tool_result` the model sees for any denial.

## Versioning policy (issue #19)

- The host speaks `MOH_EXTENSION_API_VERSION` (`"major.minor"`); the current major is **1**.
- **Additive-only within a major**: new hooks and context fields may be added; existing ones never change meaning or disappear.
- `apiVersion` is **mandatory**; a major mismatch refuses to load (warning only, session continues). A mismatch detected at hot-reload keeps the previous instance running.
- Deprecated APIs survive one full major.
- Minor version gaps are fine: the host ignores capabilities newer than itself.

## Loading and lifecycle

- Extensions are loaded at session start; load failures are warnings (`extension_failed` events), never fatal.
- Hot-reload via file watchdog, with `ctx.state` carried over.
- No sandboxing in v1 — consent plus veto-only hooks is the trust model; npm dependency installs require per-change authorization.
