# Embedding moh as a library

**Who this is for:** you are embedding `@moh/core` in your own program —
a bot, a pipeline, an evaluation harness, your own client. If you instead
want to observe/restrict a running moh session from inside it, read
[extensions.md](extensions.md).

Everything you need is the ADR-0004 keep-list exported from
`@moh/core`. The three pieces that matter:

1. **`sessionFromConfig`** — the single assembly path (ADR-0005).
2. **The event log** — `session.events`, an async iterable that *is* the
   session: streaming, persistence, resume are all projections of it.
3. **Headless permission seams** — permission rules as strings, one
   grammar everywhere (ADR-0007), plus optional consent callbacks.

## A working walkthrough

The full runnable script lives at
[examples/library-walkthrough.ts](examples/library-walkthrough.ts) (`bun
docs/extending/examples/library-walkthrough.ts` from the repo root).

### 1. Assemble a session

```ts
import { sessionFromConfig } from "@moh/core";

const assembled = sessionFromConfig({ cwd, home, provider });
if ("error" in assembled) throw new Error(assembled.error.message);
const { session, store } = assembled;
```

`sessionFromConfig` owns the whole choreography: moh.json read, project +
user MCP server merge, provider resolution, subagent/memory wiring, store
creation, session creation. It returns an explicit
`{ session, store } | { error }` — **no silent fallbacks**. Provider
resolution is one path: a pre-built `provider` instance (used here, e.g. a
`MockProvider.cassette` for evals) > an explicit `providerRef` (like the
CLI's `--provider`) > moh.json `provider` > the zero-config `"mock"`
default.

`AssemblyError.kind` tells you what to do: `config` / `provider` are
user-fixable (surface the `message`); `session` is a startup validation
error (e.g. a corrupt resumed log). The store is only created after
validation, so a broken config leaves no orphan session file.

### 2. Consume the session through `events`

The event log is the session: an append-only sequence of `AgentEvent`s
(`session_start`, `user_message`, `assistant_delta`, `tool_call`,
`tool_result`, `model_call`, `done`, `error`, `cancelled`, …). Consume it
as an async iterable while turns run:

```ts
async function watch() {
  for await (const event of session.events) {
    console.log(JSON.stringify(event));
    if (event.type === "done") break;
  }
}
const [turn] = await Promise.all([session.send("check the repo"), watch()]);
await session.dispose();
```

Every event is also persisted (the `sink` you can add via
`overrides.sink` fans out on top of the store append) to
`store.file` — one append-only JSONL per session, which you can `load()`
to resume or `fork()` to branch later.

### 3. Permissions, headless

Permission rules have one string grammar (ADR-0007), the same one the
TUI renders and the CLI's `--allow`/`--deny` flags parse:

```
rule      := tool | tool ":" argspec
argspec   := command-prefix (bash) | path-glob (any path-arg tool)
```

Examples: `bash` (bare tool), `bash:git status` (shell-word token
prefix), `write:src/**`, `edit:docs/*.md` (root-anchored path globs). The
effect ("allow"/"deny") is not part of the string; the caller supplies it.
The core owns the codec:

```ts
import { formatRule, parseRule, overridesFromFlags, RuleError } from "@moh/core";

const rule = parseRule("bash:git status", "allow"); // throws RuleError on bad input
formatRule(rule); // -> "bash:git status" — every formatted rule reparses
```

`parseRule` rejects empty rules, compound bash commands (one flag per
segment) and `tool:` with no matcher. Tokens mixing `"` with whitespace
cannot round-trip (documented limit — the grammar has no escape
sequence). For the CLI-shaped case there is one seam:

```ts
overrides: { permissionFlags: overridesFromFlags(["bash:git status"], ["write:secrets/**"]) }
```

Flags merge on top of moh.json permission overrides — caller wins. If you
want the structured form instead, pass `overrides.permissions.overrides`
directly (`tools`/`bashAllow`/`pathAllow`/… lists).

### 4. Consent seams (or none)

Without consent callbacks, the session is **headless fail-fast**: a tool
that isn't permitted by the rules becomes a structured denial the model
sees (never a prompt), and project MCP servers that need trust are not
started. To make it interactive instead, inject the seams — this is the
same interface the TUI uses:

```ts
const assembled = sessionFromConfig({
  cwd, home, provider,
  consent: {
    onPermissionRequest: async (tool, args) => /* "yes" | "always" | "no" */ "no",
    onAskUser: async (question) => /* an AskUserResult */ { choice: "1" },
    onMcpTrust: async (server) => /* "yes" | "always" | "no" */ "no",
  },
});
```

`"always"` answers become runtime rules (tier 3 — they only narrow, never
widen built-in defaults) and are recorded as `permission_rule_added`
events, so they persist across resume of the same log.

## What's intentionally not here

`@moh/core` exports a curated surface (ADR-0004): the session entrance,
`sessionFromConfig` and its types, the permission-rule codec, and what
the shipped clients need. Provider registry plumbing, memory internals,
subagent presets, and skills discovery are internal — if you need one of
those doors opened, that's an issue + ADR, not an import path.
