# Extension writers' guide

**Who this is for:** you are writing a module against the `@moh/extension`
contract — code that observes a running moh session and can only make it
*more* careful: veto a dangerous tool call, ask the user before one runs,
inspect a tool result, shape a compaction, contribute a command, panel or
tool. An extension can never grant a permission. If you instead want to
*use* extensions, read the `Extensions` page; to embed moh in your own
program, that is the library-user door in the repository's `docs/extending/`
chapters.

This page is version-matched to your binary: the signatures here describe
the `@moh/extension` this build ships (apiVersion **1.18** at the time of
writing — check `moh extension --help` or your version's manual).

## A minimal extension that runs

An extension is a module whose **default export** is a `defineExtension(...)`
result. Save this as `no-rm-rf.mjs`:

```js
import { defineExtension, MOH_EXTENSION_API_VERSION } from "@moh/extension";

export default defineExtension({
  name: "no-rm-rf",
  version: "0.1.0",
  apiVersion: MOH_EXTENSION_API_VERSION,
  setup(ctx) {
    ctx.onToolCall(({ name, args }) => {
      if (name !== "bash") return;
      const command = String(args?.command ?? "");
      if (command.trimStart().startsWith("rm -rf")) {
        return { veto: true, reason: "no-rm-rf: refusing recursive force delete" };
      }
    });
  },
});
```

With a manifest beside it (next section), drop both into
`~/.moh/extensions/` or point moh.json at the folder:

```json
{
  "extensions": ["./extensions/no-rm-rf"]
}
```

On the next session start moh asks you to enable it (one consent question,
remembered per file content), and from then on every `rm -rf ...` bash call
is denied — even in yolo mode.

## The manifest (`moh.extension.json`)

A file extension loads only with a **static manifest** beside its entry
point, naming the file:

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | the extension's identity, shown in the consent question |
| `version` | `string` | the extension's own version |
| `entry` | `string` or `string[]` | the module file(s) this manifest speaks for, relative to the manifest's folder (an installed package never loads an entry outside it) |
| `capabilities` | `string[]` | the capability slots the user is asked to grant |
| `dependencies` | `Record<string, string>` | optional npm packages moh installs for you — **exact versions only** (`"3.23.8"`, never `"^3.23.8"`) |

The manifest is the **authority**: consent signs its SHA-256, and at import
the runtime verifies every capability your `defineExtension` declares is
declared in the manifest — a superset refuses the load loudly. A missing or
malformed manifest refuses the load before consent is asked and before your
code runs. Any manifest byte change (including a *widening* edit that adds
capabilities) re-asks the consent, highlighting the added slots.

## Capability slots and what a yes grants

Every slot your manifest declares becomes part of the consent question;
each scope renders one concrete effect sentence. The slots the shipped
runtime knows:

| Slot | What a yes grants (the consent's sentence) |
| --- | --- |
| `observe`, `veto`, `ask` | the base hooks: watch the loop and restrict tool calls |
| `spawn-subagent` | "may create up to 10 concurrent child sessions and steer or stop them" |
| `contribute-commands` | contribute slash commands the user can run like native ones |
| `contribute-panels` | one panel in the extensions rail (max 4 visible across all extensions) |
| `contribute-overlays` | one full-screen overlay, opened by your command, closed with `Esc` |
| `path:<glob>` | "may read and modify files under `<glob>`, including create, rename, delete" |
| `host:<domain>` | "may contact `<domain>` over https" (`host:*` needs a manifest `reasoning` the consent displays) |
| `credential:<ref>` | the host injects the named credential as a bearer into your `fetch` — the value never crosses the seam |
| `tool:<name>` / `tool:*` | "may ask the host to run the `<name>` tool through moh's normal permission gate" |
| `contribute-tool:<name>` | "will add a `<name>` tool the model can call; its code runs when the model invokes it" |
| `endpoint:<ref>` | single-shot model calls through moh's Route against that endpoint (calling and listing) |
| `replace-prompt-section:<name>` | replace one of the six data prompt sections (`environment`, `tools`, `skills`, `memory`, `session_state`, `mpm`) per model call |

Capability-gated methods on the setup context exist **only when the grant
covers the slot** (enforcement by absence): without the grant the property
is not there, so guard with
`typeof ctx.registerCommand === "function"` and degrade.

## Hooks and their ordering

All hooks are additive-only and observe or restrict; none can widen
permissions. Within one session/turn:

1. `onSessionStart` — once, at session start.
2. `beforeTurn` — once per user send, before anything is logged. May return
   `{ model: "endpoint/model-id" }` (route this turn) or
   `{ confirm: { reason, onResolved? } }` (ask the user before the turn is
   sent; `onResolved` tells you `send`, `cancel` or `refuse`).
3. `beforeModelCall` — per model call; read the assembled prompt, or return
   `{ sections: { memory: "..." } }` to replace a granted prompt section
   (`null` hides it). A second extension touching an already-replaced
   section is refused; the core writes a provenance line at the head of
   whatever it replaced, and `prompt_override` log events record every
   change.
4. `onToolCall` — per tool call. Return `{ veto: true, reason? }` (kills the
   call, outranks user rules and every mode) or `{ ask: true, reason? }`
   (hands it to the human consent prompt — a question, never a grant; no
   "always" answer exists, and in yolo it becomes a recorded denial). The
   first decision wins, in registration order.
5. `onToolResult(tools, hook)` — per settled call of the tools you name;
   return `{ withhold: { reason } }` to replace the output the model sees
   with a refusal naming you. You cannot rewrite a result in place.
6. `onModelError` — per provider failure the route does not already handle;
   return `{ model: ref }` to propose an alternative the core retries on,
   validated like any manual switch.
6b. `onCompaction` — consulted before a compaction summarizes; name section
   ids to **drop** from the summary's input. You can only remove, user
   messages and chrome are never offered, and the core keeps a survival
   floor (60% of the offered text) no matter what you return; `onApplied`
   tells you the cut as actually applied.
7. `onEvent` — every event-log entry, in appended order.
8. `afterTurn` — the turn outcome (`{ status, reason?, message? }`,
   `synthetic: true` for turns you requested yourself).
9. `onSessionEnd` — once, when the client disposes the session.

**Deadlines:** every turn-path hook runs under a wall-clock ceiling
(default 30 s, moh.json `hookTimeoutMs`). Expired or thrown, the hook
contributes nothing, the turn proceeds, and one visible `extension_failed`
records it. A silence never vetoes, never asks. Section replacements are
judged against a shorter 5 s window; a replacement returned past it loses
only the replacement.

**Restrict-only is absolute.** Extension code can never grant or alter
permissions, touch consent files, disable another extension, bypass another
extension's veto, or mask log events — these five prohibitions are enforced
in the core, and no consent can authorize them.

## The setup context, in short

- `ctx.state` — durable per-extension store, carried across hot-reloads.
  Shared by the parent session and every child it spawns: key
  conversation-shaped state by the hook context's `session.id`.
- `ctx.appendToPrompt(note)` — a durable line in the `extension_notes`
  prompt section. `ctx.setPromptNote(text | null)` — one per-turn note,
  cleared at each turn start.
- `ctx.appendEvent({ name, payload? })` — a structured record in the session
  log (JSON-serializable, 8 KiB cap, 50 events per extension per turn;
  secret-shaped payload keys are redacted).
  `ctx.setStatus(text | null)` — one ephemeral footer status.
- `ctx.registerCommand({ name, description?, run })` — a slash command;
  its returned text is its whole output in every client. Collisions with
  native commands or skills are refused, your extension keeps running.
- `ctx.registerPanel({ name, render, onKey? })` — one rail panel; `render`
  returns Ink elements the client draws untouched. `ctx.registerOverlay` —
  a full-screen surface opened by your command, closed with `Esc`. Both are
  invisible in headless (visible absence, never a mock).
- `ctx.registerTool({ name, description, execute })` — a tool the model can
  call, riding the same runner and permission gate as every session tool.
- `ctx.host` — the ask-the-host seam, present only when a scope is granted:
  `readFile`/`writeFile`/... under `path:`, `fetch` under `host:`/`credential:`,
  `runTool` under `tool:`, `modelCall`/`listModels` under `endpoint:`. Every
  operation lands in the log (`host_op` / `host_refused`); typed refusals
  are normal outcomes, never exceptions.
- `ctx.spawnSubagent(spec)`, `ctx.subagentActivity(callId)`,
  `ctx.steerSubagent(callId, message)`, `ctx.stopSubagents()` — the
  delegation envelope: at most ten children per extension per session,
  each within the session's iteration ceiling, no grandchildren. A callId
  you did not spawn resolves to `null` — members never address each other.
- `ctx.requestTurn(text)` — one synthetic correction turn, marked in the
  log, capped at 2 consecutive; the core owns the cap.

## Versioning policy

- apiVersion is `"major.minor"`; **major must match the host** or the load
  is refused (a visible warning, the session continues). Minor gaps are
  fine in both directions: an older runtime ignores what it does not know.
- Additive-only within a major: new hooks and fields may appear; existing
  ones never change meaning or disappear.
- A capability-gated method absent on an older host is not a no-op — an
  unconditional call throws inside `setup()` and fails the load. Guard by
  absence.

## Shipping it

- `~/.moh/extensions/<name>/` — what `moh extension add` installs; a
  package subdirectory (manifest + entry file) is discovered at session
  start and loads through the same consent as a loose file.
- `moh.json` `"extensions"` — declare the path for everyone working on the
  project.
- Verify with `/extensions` (or `moh extension list`): it shows each
  extension's declared capabilities, registrations and any load failures.
- npm dependencies go in the manifest, exact-pinned; moh installs them
  without executing any scripts.

The full contract — every type, every refusal reason, the orchestration
walkthrough and the design ADRs — lives in the repository's
`docs/extending/` chapters; this page is the bundled companion, and a new
moh release updates it together with the contract itself.
