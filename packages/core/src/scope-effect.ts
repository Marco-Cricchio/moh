import { isCredentialScope, credentialScopeRef, credentialEffectSentence } from "./credential-scope";
import { isToolScope, toolEffectSentence, isContributeToolScope, contributeToolName, contributeToolEffectSentence } from "./tool-scope";
import { isEndpointScope, endpointScopeRef, endpointEffectSentence } from "./endpoint-scope";
import { isHostScope, isPathScope, TOTAL_HOST_WILDCARD, validateHostScope, validatePathScope, pathScopeGlob } from "./host-scope";

/**
 * The core-owned effect-sentence renderer (ADR-0064): a scope becomes one
 * concrete sentence the consent question shows — never the naked string
 * alone. `null` for capabilities this renderer does not speak (the
 * existing slots render as before).
 */
export function scopeEffectSentence(capability: string): string | null {
  // ADR-0069: the credential scope's sentence lives in its own module;
  // this single renderer stays the one consent reads.
  if (isCredentialScope(capability)) {
    return credentialEffectSentence(credentialScopeRef(capability));
  }
  if (isHostScope(capability)) {
    if (capability === TOTAL_HOST_WILDCARD) {
      return "may contact any host on the internet over https — total network access";
    }
    const check = validateHostScope(capability);
    if (!check.ok) return null;
    if (check.wildcard) {
      const parent = check.host.slice(2);
      const base = `may contact any subdomain of \`${parent}\` over https`;
      return check.port !== undefined ? `${base} on port ${check.port}` : base;
    }
    const named = `\`${check.host}${check.port !== undefined ? `:${check.port}` : ""}\` over https`;
    return `may contact ${named}`;
  }
  if (isEndpointScope(capability)) {
    return endpointEffectSentence(endpointScopeRef(capability));
  }
  if (isContributeToolScope(capability)) {
    return contributeToolEffectSentence(contributeToolName(capability));
  }
  if (isToolScope(capability)) {
    return toolEffectSentence(capability);
  }
  // ADR-0053/0055: the delegation slot's envelope is core-enforced (the
  // 10-children cap, no grandchildren), so the question can state it as a
  // fact, not a promise.
  if (capability === "spawn-subagent") {
    return "may create up to 10 concurrent child sessions and steer or stop them";
  }
  if (!isPathScope(capability)) return null;
  const check = validatePathScope(capability);
  const glob = check.ok ? check.glob : pathScopeGlob(capability);
  return `may read and modify files under \`${glob}\`, including create, rename, delete`;
}

/** Effect sentences for every scope in a grant, in order. */
export function scopeEffectSentences(capabilities: readonly string[]): string[] {
  return capabilities
    .map(scopeEffectSentence)
    .filter((s): s is string => s !== null);
}

