/**
 * ADR-0068: the `endpoint:<ref>` scope — an extension asks the host for a
 * single model call against a user-configured endpoint, executed through
 * the Route. Pure module: validation and the per-call check decide; the
 * runtime (extensions.ts) performs and logs, the session (session.ts)
 * resolves the endpoint, runs the Route and records usage.
 *
 * Decisions owned here:
 * - one ref per grant: the scope names one endpoint of moh.json by its
 *   profile name; a model id is not part of the grant (the extension
 *   picks any model that endpoint serves);
 * - the grant includes listing that endpoint's models — the consent
 *   sentence states both powers in one sentence;
 * - per-call thinking-level override is bounded by the model's thinking
 *   capability: outside levels are a typed refusal, never a remapping
 *   (the capability decision itself lives in the session seam, where the
 *   endpoint profiles and the catalog are at hand).
 */

export const ENDPOINT_SCOPE_PREFIX = "endpoint:";

/** True when the capability string is an endpoint scope (`endpoint:<ref>`). */
export function isEndpointScope(capability: string): boolean {
  return capability.startsWith(ENDPOINT_SCOPE_PREFIX);
}

/** The endpoint half of an `endpoint:<ref>` scope string. */
export function endpointScopeRef(capability: string): string {
  return capability.slice(ENDPOINT_SCOPE_PREFIX.length);
}

export type EndpointScopeValidity = { ok: true; ref: string } | { ok: false; reason: "malformed"; message: string };

/**
 * Load-time validation of one `endpoint:<ref>` capability. The ref is an
 * endpoint profile name: non-empty, no whitespace, no NUL, no "/" (a
 * model id is a call-time choice, never part of the grant).
 */
export function validateEndpointScope(capability: string): EndpointScopeValidity {
  const ref = endpointScopeRef(capability);
  if (ref === "" || /\s/.test(ref) || ref.includes("\0") || ref.includes("/")) {
    return {
      ok: false,
      reason: "malformed",
      message: `invalid endpoint scope "${capability}": the ref is an endpoint name from moh.json, without whitespace or "/" ("${ENDPOINT_SCOPE_PREFIX}<endpoint>")`,
    };
  }
  return { ok: true, ref };
}

/** All endpoint scopes in a capability grant (order preserved). */
export function endpointScopesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter(isEndpointScope);
}

export type EndpointScopeCheck = { ok: true } | { ok: false; reason: "outside_scope" };

/**
 * The per-call check: one ref per grant, exact name match. The model id
 * is not scoped — every call against the granted endpoint is in scope;
 * the log records each one.
 */
export function checkEndpointScope(endpoint: string, scopes: readonly string[]): EndpointScopeCheck {
  for (const scope of scopes) {
    if (!isEndpointScope(scope)) continue;
    const check = validateEndpointScope(scope);
    if (check.ok && check.ref === endpoint) return { ok: true };
  }
  return { ok: false, reason: "outside_scope" };
}

/**
 * The consent effect sentence (ADR-0068): both powers, one sentence —
 * the call, the listing, and the bounded per-call reasoning-level
 * override.
 */
export function endpointEffectSentence(ref: string): string {
  return `may call and list the models of \`${ref}\`; may choose the reasoning level per call, within those supported`;
}
