# ADR-0034: `onToolResult` — inspecting a tool result before it reaches the model

Status: accepted · Date: 2026-09-18 · Parent: wayfinder map #799, ticket #816
Consumer: Jev anti-injection, tool half (#791)

## Context

`onToolCall` fires **before** a tool runs and can only veto it. Nothing fires **after** a
tool produces a result but **before that result enters the model's context**
(`ToolRunner.run` appends `tool_result` and builds the feedback part in one step,
`packages/core/src/session/tool-runner.ts:227-240`). An extension therefore cannot act on
what a tool returns.

That gap is exactly where the anti-injection use case needs to stand. External content —
a web page fetched, a rendered page traversed — is the one tool output an attacker
controls, and it is the classic prompt-injection vector: text in the page addressed to the
assistant, telling it to exfiltrate a file or ignore its instructions. Today such content
goes from the network straight into the model's context, unexamined. The Jev guardrail
(#786) covers `bash` before execution; this seam covers external text after retrieval.

## Decision

**Go.** One new optional hook, `onToolResult`, registered per tool-name list, apiVersion
bumping to **`1.3`** (additive — an older runtime ignores it, a no-op).

```ts
export interface ToolResultContext {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  /** The tool's textual output, as the model would receive it. */
  readonly output: string;
}

export interface ToolResultHookResult {
  /** Replace the result the model sees with a refusal-shaped text. */
  readonly withhold: { readonly reason: string };
}

export type ToolResultHook =
  (ctx: ToolResultContext) => ToolResultHookResult | void | Promise<ToolResultHookResult | void>;
```

Registered through the setup context, **scoped to the tool names the extension declares**:

```ts
ctx.onToolResult(["fetch", "browser"], hook);
```

Key decisions, each with its rationale:

1. **One outcome: `withhold`.** The extension may replace a result with a refusal-shaped
   text; it cannot rewrite, truncate or redact a result in place. Partial redaction was
   rejected as the v1 shape: rewriting tool output silently changes the data the model
   reasons over (a half-edited JSON is a corrupted result, not a sanitized one), and the
   one case that matters — content from a hostile page — is fully served by withholding
   it. Redaction can be added later as its own decision if a real use case asks.

2. **The hook runs before the `tool_result` is appended, and the withheld text is what the
   log holds.** Replay, resume and fork rebuild message parts from the event log, so
   writing the original and showing the replacement would mean the log lies about what the
   model saw. The event log *is* the session (CONTEXT.md): it records what happened, which
   after a withhold is the refusal. The inspected content is not retained.

3. **Scoped to declared tool names.** The extension names the tools it wants (`fetch`,
   `browser`, future MCP sources); the core dispatches the hook only for those, and the
   extension's list is visible in its setup code. Unscoped inspection was rejected: a hook
   on every result would run extension code (and a Jev round-trip, in this use case) on
   `read` output and `bash` output — the user's own material, at a cost that scales with
   every line of code read.

4. **Text results only.** A result carrying an image (`result.image`, #778) is never
   offered to the hook: an image is not text an extension can judge, and withholding a
   screenshot the model explicitly asked for would break the calling turn's contract for
   no security gain (the pixels of a page are not a text-injection vector). Documented so
   the boundary is deliberate rather than incidental.

5. **Refusal copy is the extension's, and it is transparent to the model.** The withheld
   text is the extension's `reason`, rendered into the refusal-shaped result, so the model
   learns *that* content was withheld, *by whom* and *why in one phrase* — and can tell the
   user "the page content was withheld". An indistinguishable generic tool error was
   rejected: a model that cannot explain a refusal will retry the same fetch or route
   around it, which is exactly what the guardrail is trying to prevent.

6. **Composition: every hook runs, one withhold wins.** Unlike the first-wins rule of
   `onToolCall` and `beforeTurn` (where the *decision* is exclusive), here each extension
   gets to inspect what the others did not withhold, and the first withhold short-circuits
   the rest — the result is already withdrawn, so there is nothing left to judge. Two
   withholdings never produce two texts: the first wins, deterministically by registration
   order.

7. **Fail-open, always.** A hook that throws, or that has not answered within the hook
   timeout, yields one `extension_failed` and the **original result proceeds** to the
   model. A guardrail that can silently block the agent's work when it misbehaves is worse
   than one that occasionally misses an injection; the visible record makes the miss
   auditable. This matches the Jev client's failure discipline and ADR-0033's hook rule.

8. **Observation and refusal only — never a grant.** The hook cannot turn a failed result
   into a successful one, cannot add output, and cannot touch permissions. Its whole power
   is to replace one result with a refusal text. The veto-only principle is untouched: an
   extension may restrict what the model sees, never widen it.

## Consequences

- `packages/extension/src/index.ts`: the context/result/hook types, the scoped
  registration in `ExtensionSetupContext`, apiVersion `1.3`.
- `packages/core/src/extensions.ts`: dispatch with the tool-name filter, hook-error
  collection, the timeout policy shared with the other hooks.
- `packages/core/src/session/tool-runner.ts`: the dispatch lands between `#execute`
  settling and the `tool_result` append (one insertion point in `run`'s `runOne`), so the
  log and the feedback part (built from the same `result`) both carry the withheld text.
  `LoopExtensions` grows the dispatch it needs.
- The `read`/`grep`/`glob`/`bash` paths are untouched by construction (§3).
- Docs: `docs/extending/extensions.md` (the hook, its scope, its outcomes) and
  `docs/manual/jev.md` (what a withheld page means to a user) ship with the implementation
  PRs.
- Rejected: rewriting/redacting in place (silent data corruption); a hook per tool
  programmatically (core cannot know what is external); unscoped dispatch (cost on every
  result); logging the original and showing the replacement (the log would lie about what
  the model saw); a generic error for the model (unexplainable refusals invite retries);
  fail-closed on timeout (an extension could hold the agent hostage); composing multiple
  withholds into a combined text (no reader benefit, more surface).
