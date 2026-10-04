/** ADR-0064: the single authorization entry point for host operations.
 * Scope-specific algorithms stay in their leaf modules; execution and
 * audit logging stay in the extension runtime. Credentials are checked
 * here before the runtime ever resolves a secret.
 */
import { checkPathScope, checkHostScope, type PathScopeCheck, type HostFetchCheck } from "./host-scope";
import { checkToolScope } from "./tool-scope";
import { checkEndpointScope } from "./endpoint-scope";
import { isCredentialScope, credentialScopeRef } from "./credential-scope";

type ExactCheck = { ok: true } | { ok: false; reason: "outside_scope" };
type PathRequest = { kind: "path"; path: string; root: string; isDenied: (path: string) => boolean };
type HostRequest = { kind: "host"; url: URL; isDenied: (host: string) => boolean };
type ExactRequest = { kind: "tool" | "endpoint" | "credential"; ref: string };

export function checkScope(request: PathRequest, scopes: readonly string[]): PathScopeCheck;
export function checkScope(request: HostRequest, scopes: readonly string[]): HostFetchCheck;
export function checkScope(request: ExactRequest, scopes: readonly string[]): ExactCheck;
export function checkScope(request: PathRequest | HostRequest | ExactRequest, scopes: readonly string[]): PathScopeCheck | HostFetchCheck | ExactCheck {
  switch (request.kind) {
    case "path": return checkPathScope(request.path, scopes, request.root, request.isDenied);
    case "host": return checkHostScope(request.url, scopes, request.isDenied);
    case "tool": return checkToolScope(request.ref, scopes);
    case "endpoint": return checkEndpointScope(request.ref, scopes);
    case "credential": return scopes.some((scope) => isCredentialScope(scope) && credentialScopeRef(scope) === request.ref)
      ? { ok: true } : { ok: false, reason: "outside_scope" };
  }
}
