/**
 * #1424: the scope table — one descriptor per scope kind (prefix, load-time
 * validation, per-call check, consent effect sentence), with the single
 * `checkScope` dispatcher and the single `scopeEffectSentence` renderer
 * reading it. Grammar-free filesystem and glob matching stays in host-scope.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, join } from "node:path";
import { caseInsensitiveAt, globMatches, resolveReal } from "./host-scope";

/** The scope prefixes the shipped host knows (ADR-0071: a prefix becomes
 * a known slot only when its phase ships — F1 `path:`, F2 `host:`). */
export const PATH_SCOPE_PREFIX = "path:";
export const HOST_SCOPE_PREFIX = "host:";

/** True when the capability string is a path scope (`path:<glob>`). */
export function isPathScope(capability: string): boolean {
  return capability.startsWith(PATH_SCOPE_PREFIX);
}

/** True when the capability string is a host scope (`host:<domain>`). */
export function isHostScope(capability: string): boolean {
  return capability.startsWith(HOST_SCOPE_PREFIX);
}

/** The glob half of a `path:<glob>` scope string. */
function pathScopeGlob(capability: string): string {
  return capability.slice(PATH_SCOPE_PREFIX.length);
}

type PathScopeValidity = { ok: true; glob: string } | { ok: false; reason: "malformed" | "absolute"; message: string };

/**
 * Load-time validation of one `path:<glob>` capability. An absolute path
 * in a manifest capability fails loudly (ADR-0065): a capability naming
 * outside-the-project targets is exactly what consent must not hide.
 */
export function validatePathScope(capability: string): PathScopeValidity {
  return validatePathGlob(pathScopeGlob(capability), capability);
}

/** Validates the glob half alone (#1224): a spawn-time scope arrives as a
 * bare glob, which `pathScopeGlob`'s unconditional slice would corrupt. */
export function validatePathGlob(glob: string, original = glob): PathScopeValidity {
  if (glob.trim() === "" || glob.includes("\0")) {
    return { ok: false, reason: "malformed", message: `invalid path scope "${original}": empty or malformed glob` };
  }
  if (isAbsolute(glob)) {
    return { ok: false, reason: "absolute", message: `invalid path scope "${original}": absolute paths are not allowed — scopes are project-root-relative` };
  }
  return { ok: true, glob };
}

/** All path scopes in a capability grant (order preserved). */
export function pathScopesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter(isPathScope);
}

/** All host scopes in a capability grant (order preserved). */
export function hostScopesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter(isHostScope);
}

/**
 * The total wildcard (`host:*`) exists only with a manifest `reasoning`
 * string (ADR-0066, the Figma model): the author's justification the
 * consent question displays. moh never verifies the text — the owner
 * reads it and decides.
 */
export const TOTAL_HOST_WILDCARD = "host:*";
/** The manifest key carrying the total-wildcard justification. */
export const HOST_SCOPE_REASONING_KEY = "reasoning";

type HostScopeValidity =
  | { ok: true; host: string; port?: number; wildcard: boolean }
  | { ok: false; reason: "malformed"; message: string };

/**
 * Load-time validation of one `host:<domain>` capability (ADR-0066).
 * Identity is string equality with the URL host — no origin-pattern
 * grammar. `host:*.example.com` covers one label of subdomains as
 * written; an explicit port is allowed for development. https is
 * implicit and never spelled inside the string.
 */
export function validateHostScope(capability: string): HostScopeValidity {
  const spec = capability.slice(HOST_SCOPE_PREFIX.length);
  if (spec.trim() === "" || spec.includes("\0")) {
    return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": empty or malformed host` };
  }
  // Split the optional port off the last colon (IPv6 literals are not
  // part of this grammar — a bracketed literal refuses as malformed).
  const colon = spec.lastIndexOf(":");
  let hostPart = spec;
  let port: number | undefined;
  if (colon >= 0) {
    hostPart = spec.slice(0, colon);
    const portPart = spec.slice(colon + 1);
    if (!/^\d{1,5}$/.test(portPart)) {
      return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": port must be numeric` };
    }
    port = Number(portPart);
    if (port < 1 || port > 65535) {
      return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": port out of range` };
    }
  }
  if (hostPart !== "*") {
    // Lowercase letters, digits, hyphens, dots; single labels; `*.`
    // wildcard only as a whole leftmost label.
    if (!/^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(hostPart) || hostPart.includes("..")) {
      return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": not a hostname` };
    }
    // One wildcard label per scope: `*.*.example.com` refuses.
    if ((hostPart.match(/\*/g) ?? []).length > 1) {
      return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": at most one wildcard label` };
    }
  } else if (port !== undefined) {
    // The total wildcard is whole-network: pinning it to a port is a
    // grammar outside ADR-0066 (and would dodge the reasoning vocabulary).
    return { ok: false, reason: "malformed", message: `invalid host scope "${capability}": the total wildcard takes no port` };
  }
  return { ok: true, host: hostPart, port, wildcard: hostPart.startsWith("*.") };
}

/**
 * The host a request URL must string-match against one validated scope
 * (ADR-0066: identity stays equality). The default https port is
 * implicit on both sides; an explicit default port in a request URL
 * normalizes to no port.
 */
export function hostMatchesScope(scope: HostScopeValidity & { ok: true }, url: URL): boolean {
  let requestHost = url.hostname.toLowerCase();
  const requestPort = url.port === "" || (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")
    ? undefined
    : Number(url.port);
  // https implicit: a scope without a port speaks https; an http request
  // URL matches only a development scope that spelled a port (local dev
  // servers), never a bare `host:<domain>` grant.
  if (url.protocol !== "https:") {
    if (scope.port === undefined) return false;
    if (scope.port !== requestPort) return false;
  } else if (scope.port !== undefined && scope.port !== requestPort) {
    return false;
  }
  if (scope.host === "*") return true;
  if (scope.wildcard) {
    const suffix = scope.host.slice(2); // strip `*.`
    // One label: the remainder before the suffix must be a single label.
    if (!requestHost.endsWith(`.${suffix}`)) return false;
    const prefix = requestHost.slice(0, requestHost.length - suffix.length - 1);
    return prefix !== "" && !prefix.includes(".");
  }
  return requestHost === scope.host;
}

type PathScopeCheck =
  | { ok: true; resolved: string }
  | { ok: false; reason: "outside_scope" | "invalid_path" | "denied"; resolved?: string };

/**
 * Real-filesystem containment (ADR-0065): `..` segments are rejected
 * before resolution; the resolved target (symlinks followed, case as the
 * filesystem holds it) must sit inside the project root AND match at
 * least one granted glob. The resolved path travels back for the log —
 * the log records the real target, never the requested path.
 *
 * `isDenied` (the user's deny rules, bound per call by the session) wins
 * over every grant — the grant never widens what moh itself may do.
 */
function checkPathScope(
  requestedPath: string,
  scopes: readonly string[],
  projectRoot: string,
  isDenied: (resolvedAbsPath: string) => boolean,
): PathScopeCheck {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "" || requestedPath.includes("\0")) {
    return { ok: false, reason: "invalid_path" };
  }
  // `..` rejected before resolution: a lexical escape is refused as a
  // policy answer even when the target happens to exist.
  const raw = isAbsolute(requestedPath) ? relative(projectRoot, requestedPath) : requestedPath;
  const segments = raw.split(/[/\\]+/).filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    return { ok: false, reason: "outside_scope" };
  }
  const abs = resolve(projectRoot, ...segments);
  // Symlinks resolved to the checked target: an existing path is checked
  // through realpath; a not-yet-existing path checks through its nearest
  // existing ancestor (creation inside an escaping symlinked directory is
  // still caught — the parent is the real target).
  const resolved = resolveReal(abs);
  const root = realpathSync(projectRoot);
  const rel = relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: "outside_scope", resolved };
  }
  // Observe the target filesystem, not the OS: macOS can host sensitive
  // volumes and Linux can host insensitive ones. Missing tails inherit
  // the nearest existing directory's behavior.
  const components = rel.split("/").filter((s) => s !== "");
  const insensitive = components.map((_, i) => caseInsensitiveAt(join(root, ...components.slice(0, i))));
  if (!matchesPathScopes(rel, scopes, insensitive)) {
    return { ok: false, reason: "outside_scope", resolved };
  }
  if (isDenied(resolved)) {
    return { ok: false, reason: "denied", resolved };
  }
  return { ok: true, resolved };
}

/**
 * Whether one project-relative path matches any granted `path:<glob>`.
 *
 * `componentInsensitive[i]` is the case behavior of the directory that
 * *contains* path component `i` (`components[i-1]`'s directory, the root
 * for `i = 0`), as observed on the real filesystem. It is deliberately
 * per component: deriving one answer from the leaf directory and
 * applying it to the whole path let a sensitive ancestor (`SRC` on a
 * sensitive volume) match a request for `src` on the strength of an
 * insensitive mount deeper down the same path.
 *
 * Exported as the tests-only seam: `checkPathScope` computes the answers
 * from the filesystem, a test can hand in the mixed-mount shapes a plain
 * temp directory cannot produce.
 */
export function matchesPathScopes(rel: string, scopes: readonly string[], componentInsensitive: readonly boolean[]): boolean {
  // Fold only when *every* component of the resolved path sits on an
  // insensitive filesystem. A mixed path (a sensitive ancestor above an
  // insensitive mount, or the reverse) keeps exact-case matching: the
  // conservative answer is to require the spelling the scope wrote,
  // never to widen the grant on a partial answer.
  const fold = componentInsensitive.length > 0 && componentInsensitive.every(Boolean);
  return scopes.some((capability) => {
    if (!isPathScope(capability)) return false;
    const check = validatePathScope(capability);
    if (!check.ok) return false;
    return globMatches(check.glob, rel, fold);
  });
}

type HostFetchCheck =
  | { ok: true }
  | { ok: false; reason: "outside_scope" | "invalid_url" | "denied"; target?: string };

/**
 * The per-call scope check for `host.fetch`: the request URL's host must
 * string-match at least one granted `host:` scope. The user's deny rules
 * beat the grant per call, keyed by the request host. Pure module: the
 * runtime (extensions.ts) performs the request and logs.
 */
function checkHostScope(
  url: URL,
  scopes: readonly string[],
  isDenied: (host: string) => boolean,
): HostFetchCheck {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "invalid_url" };
  }
  const matched = scopes.some((capability) => {
    if (!isHostScope(capability)) return false;
    const check = validateHostScope(capability);
    return check.ok && hostMatchesScope(check, url);
  });
  if (!matched) {
    return { ok: false, reason: "outside_scope", target: url.host };
  }
  if (isDenied(url.hostname)) {
    return { ok: false, reason: "denied", target: url.host };
  }
  return { ok: true };
}

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

type ToolScopeValidity = { ok: true; name: string; wildcard: boolean } | { ok: false; reason: "malformed"; message: string };

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

type ContributeToolScopeValidity = { ok: true; name: string } | { ok: false; reason: "malformed"; message: string };

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

type ToolScopeCheck = { ok: true } | { ok: false; reason: "outside_scope" };

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
function endpointScopeRef(capability: string): string {
  return capability.slice(ENDPOINT_SCOPE_PREFIX.length);
}

type EndpointScopeValidity = { ok: true; ref: string } | { ok: false; reason: "malformed"; message: string };

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

type EndpointScopeCheck = { ok: true } | { ok: false; reason: "outside_scope" };

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

export const CREDENTIAL_SCOPE_PREFIX = "credential:";

/** True when the capability string is a credential scope (`credential:<ref>`). */
export function isCredentialScope(capability: string): boolean {
  return capability.startsWith(CREDENTIAL_SCOPE_PREFIX);
}

/** The ref half of a `credential:<ref>` scope string. */
export function credentialScopeRef(capability: string): string {
  return capability.slice(CREDENTIAL_SCOPE_PREFIX.length);
}

type CredentialScopeValidity = { ok: true; ref: string } | { ok: false; reason: "malformed"; message: string };

/**
 * Load-time validation of one `credential:<ref>` capability. A ref is a
 * non-empty printable name without whitespace — it must survive consent,
 * manifest and log as itself.
 */
export function validateCredentialScope(capability: string): CredentialScopeValidity {
  const ref = credentialScopeRef(capability);
  if (ref.trim() === "" || /\s/.test(ref) || ref.includes("\0")) {
    return { ok: false, reason: "malformed", message: `invalid credential scope "${capability}": a ref is a non-empty name without whitespace` };
  }
  return { ok: true, ref };
}

/** All credential scopes in a capability grant (order preserved). */
export function credentialScopesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter(isCredentialScope);
}

/**
 * The consent effect sentence (ADR-0069): the owner approves "may use the
 * credential `ref`". A ref is not itself a secret; naming it in consent is
 * how the owner sees which secret a grant addresses.
 */
function credentialEffectSentence(ref: string): string {
  return `may use the credential \`${ref}\``;
}

type ExactCheck = { ok: true } | { ok: false; reason: "outside_scope" };
type PathRequest = { kind: "path"; path: string; root: string; isDenied: (path: string) => boolean };
type HostRequest = { kind: "host"; url: URL; isDenied: (host: string) => boolean };
type ExactRequest = { kind: "tool" | "endpoint" | "credential"; ref: string };

/** One descriptor per scope kind (#1424), in the order the effect renderer tests them. */
type ScopeKind = {
  readonly prefix: string;
  readonly validate: (capability: string) => { ok: true } | { ok: false; message: string };
  readonly check: (request: never, scopes: readonly string[]) => unknown;
  readonly effectSentence: (capability: string) => string | null;
};

const SCOPES = {
  credential: {
    prefix: CREDENTIAL_SCOPE_PREFIX,
    validate: validateCredentialScope,
    check: (request: ExactRequest, scopes: readonly string[]): ExactCheck => scopes.some((scope) => isCredentialScope(scope) && validateCredentialScope(scope).ok && credentialScopeRef(scope) === request.ref)
      ? { ok: true } : { ok: false, reason: "outside_scope" },
    effectSentence: (capability: string): string | null => credentialEffectSentence(credentialScopeRef(capability)),
  },
  host: {
    prefix: HOST_SCOPE_PREFIX,
    validate: validateHostScope,
    check: (request: HostRequest, scopes: readonly string[]): HostFetchCheck => checkHostScope(request.url, scopes, request.isDenied),
    effectSentence: (capability: string): string | null => {
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
    },
  },
  endpoint: {
    prefix: ENDPOINT_SCOPE_PREFIX,
    validate: validateEndpointScope,
    check: (request: ExactRequest, scopes: readonly string[]): EndpointScopeCheck => checkEndpointScope(request.ref, scopes),
    effectSentence: (capability: string): string | null => endpointEffectSentence(endpointScopeRef(capability)),
  },
  "contribute-tool": {
    prefix: CONTRIBUTE_TOOL_SCOPE_PREFIX,
    validate: validateContributeToolScope,
    check: contributesTool,
    effectSentence: (capability: string): string | null => contributeToolEffectSentence(contributeToolName(capability)),
  },
  tool: {
    prefix: TOOL_SCOPE_PREFIX,
    validate: validateToolScope,
    check: (request: ExactRequest, scopes: readonly string[]): ToolScopeCheck => checkToolScope(request.ref, scopes),
    effectSentence: (capability: string): string | null => toolEffectSentence(capability),
  },
  path: {
    prefix: PATH_SCOPE_PREFIX,
    validate: validatePathScope,
    check: (request: PathRequest, scopes: readonly string[]): PathScopeCheck => checkPathScope(request.path, scopes, request.root, request.isDenied),
    effectSentence: (capability: string): string | null => {
      const check = validatePathScope(capability);
      const glob = check.ok ? check.glob : pathScopeGlob(capability);
      return `may read and modify files under \`${glob}\`, including create, rename, delete`;
    },
  },
} satisfies Record<string, ScopeKind>;

/** ADR-0064: the single authorization entry point for host operations.
 * execution and
 * audit logging stay in the extension runtime. Credentials are checked
 * here before the runtime ever resolves a secret.
 */
export function checkScope(request: PathRequest, scopes: readonly string[]): PathScopeCheck;
export function checkScope(request: HostRequest, scopes: readonly string[]): HostFetchCheck;
export function checkScope(request: ExactRequest, scopes: readonly string[]): ExactCheck;
export function checkScope(request: PathRequest | HostRequest | ExactRequest, scopes: readonly string[]): PathScopeCheck | HostFetchCheck | ExactCheck | undefined {
  // Only the five request kinds dispatch: any other kind returns undefined,
  // as the former `switch` without a default did.
  const kind: string = request.kind;
  if (kind === "contribute-tool" || !Object.hasOwn(SCOPES, kind)) return undefined;
  const check = SCOPES[request.kind].check as (request: PathRequest | HostRequest | ExactRequest, scopes: readonly string[]) => PathScopeCheck | HostFetchCheck | ExactCheck;
  return check(request, scopes);
}

/**
 * The core-owned effect-sentence renderer (ADR-0064): a scope becomes one
 * concrete sentence the consent question shows — never the naked string
 * alone. `null` for capabilities this renderer does not speak (the
 * existing slots render as before).
 */
export function scopeEffectSentence(capability: string): string | null {
  for (const kind of Object.values(SCOPES)) {
    if (capability.startsWith(kind.prefix)) return kind.effectSentence(capability);
  }
  // ADR-0053/0055: the delegation slot's envelope is core-enforced (the
  // 10-children cap, no grandchildren), so the question can state it as a
  // fact, not a promise.
  if (capability === "spawn-subagent") {
    return "may create up to 10 concurrent child sessions and steer or stop them";
  }
  return null;
}
