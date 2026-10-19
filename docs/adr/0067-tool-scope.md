# Tool scope: `tool:<name|*>` invokes session tools; `contribute-tool:` is a different power

The #997 matrix left the tool row ambiguous between two readings — asking the host to run an existing session tool (host-performed) and adding a new tool whose implementation is extension code (extension-performed). This ADR names both, as distinct slots, so one string never hides two trust shapes.

## Decision

- **`tool:<name|*>` is invocation only**: under the host-tool seam (ADR-0064), the extension asks the host to run a registered session tool; moh executes it through the normal ToolRunner and PermissionGate. `ctx.host.runTool(name, args)` returns the tool's typed result.
- **`contribute-tool:<name>` is the contribution slot**: the extension supplies an implementation exposed to the session's model; the model sees and calls it like any tool. The extension's code runs when the model invokes it — an extension-performed power with a different trust shape, declared with its own prefix and its own consent sentence ("will add a `search` tool the model can call; its code runs when the model invokes it"). Contribution rides the same runner and gate: the model's call passes the PermissionGate like every other tool call.
- **Whole-tool grant**: `tool:bash` authorizes Bash entire; no argv sub-scoping inside the capability. The per-call verdict belongs to the user's rules and the gate — the same split as the path scope (ADR-0065): the grant says what the extension may ask, the rule decides each call.
- **Gate unchanged**: a seam invocation follows the model's exact path — veto > user rules > mode (bypass / auto-accept / ask / headless). The ask prompt states the requester (extension, not model).
- **`tool:*` covers all session tools, built-in and MCP**, allowed without a manifest `reasoning` — the perimeter is the user's own tool set, and the consent sentence says it plainly ("may run any session tool, including MCP calls"). No reserved `custom:` marker: the `contribute-tool:` prefix replaces it.
- **Log**: seam invocations are `host_op { op: "run_tool", tool, outcome }` per ADR-0064; the model's call of a contributed tool is an ordinary `tool_call`/`tool_result` pair, with the tool's contributor visible in the registration record.

## Considered options

- One `tool:` prefix for both readings — rejected: two opposite trust shapes under one string makes the consent sentence impossible to write honestly.
- Argv-level sub-scoping in the capability — rejected: duplicates the user's permission-rule grammar (ADR-0007).

## Consequences

The orchestration envelope's tool limiting (#1127) and this slot must compose: a child's tool set intersects what the envelope named. The five-scope phase now has all five grammars; the credential arc (#1148) resolves custody, and the seam ADR's promised inventory is complete.

## Amendment — ablation (2026-10-19)

The decision above is unchanged. This amendment records where the `tool:` and `contribute-tool:` scopes live after #1424 (S3.2, delivered by #1571), the prerequisite recorded for this ADR. It adds no decision.

### What changed

- Before #1571 both scopes were in `packages/core/src/tool-scope.ts`: `TOOL_SCOPE_PREFIX`, `CONTRIBUTE_TOOL_SCOPE_PREFIX`, `TOOL_SCOPE_WILDCARD`, `isToolScope`, `toolScopeName`, `validateToolScope`, `isContributeToolScope`, `contributeToolName`, `validateContributeToolScope`, `toolScopesOf`, `contributeToolScopesOf`, `checkToolScope`, `contributesTool`, and the effect-sentence functions `toolEffectSentence` and `contributeToolEffectSentence`. For these two scopes, `packages/core/src/scope-effect.ts` dispatched to the two effect-sentence functions, and `packages/core/src/check-scope.ts` dispatched the `tool` kind to `checkToolScope`.
- Those definitions are now in `packages/core/src/scopes.ts`, and every one of the names above is still exported from there; `tool-scope.ts`, `scope-effect.ts` and `check-scope.ts` no longer exist.
- The `tool` and `contribute-tool` descriptors of the scope table in `scopes.ts` are new in #1571, each with `prefix`, `validate`, `check` and `effectSentence`. The `tool` descriptor's `check` calls `checkToolScope`; the `contribute-tool` descriptor's `check` is `contributesTool`.
- `tool:` invocation still goes through `checkScope`: `extensions.ts` calls `checkScope({ kind: "tool", … })`. `contribute-tool:` does not: `checkScope` returns `undefined` for that kind, and `extensions.ts` calls `contributesTool` directly when it registers a contributed tool, as it did before #1571. For `checkScope` itself, see the amendment to ADR-0064.

### What stays

- The rules in the Decision section are unchanged: the declarations and function bodies of the names listed above are identical before and after #1571.
- The refusal reasons are unchanged. `validateToolScope` and `validateContributeToolScope` return `malformed`, which the extension loader in `extensions.ts` reports as `invalid_tool_scope` for both prefixes; `checkToolScope` returns `outside_scope`. At run time `extensions.ts` and `session/session.ts` add `unknown_tool`, `denied` and `failed` to the `ctx.host.runTool` path. When registering a contributed tool, `extensions.ts` emits the `register_tool_refused` failure if `contributesTool` does not match its registered name against the granted names (an empty name is refused before that check; the same failure also covers a tool without `execute()`).
- The effect sentences are unchanged: "may run any session tool, including MCP calls" for `tool:*`, "may ask the host to run the `<name>` tool through moh's normal permission gate" for `tool:<name>`, and "will add a `<name>` tool the model can call; its code runs when the model invokes it" for `contribute-tool:<name>`.
- The `ToolRunner` and `PermissionGate` path, the `host_op { op: "run_tool" }` log and the registration of contributed tools are not touched by #1571: in `extensions.ts` it changes only import lines, and `session/session.ts` is not in its diff.
