/**
 * ADR-0067: the `tool:<name|*>` and `contribute-tool:<name>` scopes —
 * two distinct powers that one ambiguous string once hid. `tool:` is
 * invocation only: the extension asks the host to run an existing session
 * tool, and moh executes it through the normal ToolRunner and
 * PermissionGate. `contribute-tool:` is contribution: the extension
 * supplies an implementation the session's model can call — extension
 * code runs when the model invokes it. Pure module: validation and the
 * per-call check decide; the runtime (extensions.ts) performs and logs,
 * the session (session.ts) executes behind the seam.
 *
 * Decisions owned here:
 * - whole-tool grant: `tool:bash` authorizes Bash entire; no argv
 *   sub-scoping — the per-call verdict belongs to the user's rules and
 *   the gate (ADR-0007), the same split as the path scope (ADR-0065);
 * - `tool:*` covers all session tools, built-in and MCP, without a
 *   manifest `reasoning`: the perimeter is the user's own tool set;
 * - no reserved `custom:` marker: `contribute-tool:` replaces it — a
 *   contributed tool's name is the scope's own name, so consent, manifest
 *   and log name the same tool the model will see.
 */

export const TOOL_SCOPE_PREFIX = "tool:";
export const CONTRIBUTE_TOOL_SCOPE_PREFIX = "contribute-tool:";
/** The whole-session wildcard: every session tool, built-in and MCP. */
export const TOOL_SCOPE_WILDCARD = "*";

/** True when the capability string is an invocation scope (`tool:<name|*>`). */
export function isToolScope(capability: string): boolean {
  return capability.startsWith(TOOL_SCOPE_PREFIX);
}

/** The tool half of a `tool:<name|*>` scope string. */
export function toolScopeName(capability: string): string {
  return capability.slice(TOOL_SCOPE_PREFIX.length);
}

export type ToolScopeValidity = { ok: true; name: string; wildcard: boolean } | { ok: false; reason: "malformed"; message: string };

/**
 * Load-time validation of one `tool:<name|*>` capability. A name is
 * non-empty, without whitespace or NUL — it must survive consent,
 * manifest and log as itself, and must match a tool name a session can
 * look up.
 */
export function validateToolScope(capability: string): ToolScopeValidity {
  const name = toolScopeName(capability);
  if (name === TOOL_SCOPE_WILDCARD) return { ok: true, name, wildcard: true };
  if (name === "" || /\s/.test(name) || name.includes("\0")) {
    return { ok: false, reason: "malformed", message: `invalid tool scope "${capability}": a tool name is non-empty, without whitespace ("${TOOL_SCOPE_PREFIX}<name>" or "${TOOL_SCOPE_PREFIX}${TOOL_SCOPE_WILDCARD}")` };
  }
  return { ok: true, name, wildcard: false };
}

/** True when the capability string is a contribution scope (`contribute-tool:<name>`). */
export function isContributeToolScope(capability: string): boolean {
  return capability.startsWith(CONTRIBUTE_TOOL_SCOPE_PREFIX);
}

/** The tool half of a `contribute-tool:<name>` scope string. */
export function contributeToolName(capability: string): string {
  return capability.slice(CONTRIBUTE_TOOL_SCOPE_PREFIX.length);
}

export type ContributeToolScopeValidity = { ok: true; name: string } | { ok: false; reason: "malformed"; message: string };

/**
 * Load-time validation of one `contribute-tool:<name>` capability — the
 * same name grammar as an invocation scope, never the wildcard (a
 * wildcard contribution would hide which tools the extension's code
 * actually adds).
 */
export function validateContributeToolScope(capability: string): ContributeToolScopeValidity {
  const name = contributeToolName(capability);
  if (name === "" || /\s/.test(name) || name.includes("\0") || name === TOOL_SCOPE_WILDCARD) {
    return { ok: false, reason: "malformed", message: `invalid contribute-tool scope "${capability}": a contributed tool is named exactly ("${CONTRIBUTE_TOOL_SCOPE_PREFIX}<name>")` };
  }
  return { ok: true, name };
}

/** All invocation scopes in a capability grant (order preserved). */
export function toolScopesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter(isToolScope);
}

/** All contribution scopes in a capability grant (order preserved). */
export function contributeToolScopesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter(isContributeToolScope);
}

export type ToolScopeCheck = { ok: true } | { ok: false; reason: "outside_scope" };

/**
 * The per-call invocation check: whole-tool grant, no argv sub-scoping.
 * A scope covers a tool when it is the wildcard or names it exactly —
 * the gate, not the grant, decides each call.
 */
export function checkToolScope(tool: string, scopes: readonly string[]): ToolScopeCheck {
  for (const scope of scopes) {
    if (!isToolScope(scope)) continue;
    const check = validateToolScope(scope);
    if (check.ok && (check.wildcard || check.name === tool)) return { ok: true };
  }
  return { ok: false, reason: "outside_scope" };
}

/**
 * True when a contributed tool's name is covered by a contribution
 * grant — the registered name must be one the consent actually named.
 */
export function contributesTool(tool: string, scopes: readonly string[]): boolean {
  return contributeToolScopesOf(scopes).some((scope) => contributeToolName(scope) === tool);
}

/**
 * The consent effect sentence (ADR-0067): an invocation scope is the
 * power to *ask the host to run* — the tool still executes under moh's
 * runner and gate. The wildcard says its perimeter plainly.
 */
export function toolEffectSentence(capability: string): string | null {
  const check = validateToolScope(capability);
  if (!check.ok) return null;
  if (check.wildcard) return "may run any session tool, including MCP calls";
  return `may ask the host to run the \`${check.name}\` tool through moh's normal permission gate`;
}

/**
 * The consent effect sentence for a contribution (ADR-0067): a different
 * trust shape — the extension's code runs when the model invokes the
 * tool, never ask-the-host.
 */
export function contributeToolEffectSentence(name: string): string {
  return `will add a \`${name}\` tool the model can call; its code runs when the model invokes it`;
}
