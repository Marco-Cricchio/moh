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
