# Credential scope: user-owned secrets, reference-only access, host-side injection

Under the host-tool seam (ADR-0064), the credential scope decides how extensions use secrets without ever holding them. The prior art (research-1153) is unanimous: the value never reaches the consumer's hands — VS Code returns a session, GitHub injects into the runner, 1Password resolves at read time. moh follows the strongest of these.

## Decision

- **Storage**: OS keychain when available (macOS Keychain), explicit bounded fallback to a `0600` file under the moh dotdir otherwise (keyring where present on Linux, profile-dir ACL on Windows) — the Claude Code model, matching the existing auth-store posture. A separate namespace from the auth store: endpoint credentials are the user's provider logins; these secrets serve extensions. Like the auth store, this is not an moh.json concern.
- **Reference-only access**: `credential:<ref>` grants addressing by name. The extension declares the ref in the call (`ctx.host.fetch(url, { credential: "deploy-key" })`); the host resolves it and injects the credential at request time. There is no read-the-value API: the shape of the surface makes the path not exist.
- **The user mints, always**: creation and destruction are user surfaces (`moh secret set/rm` or the TUI equivalent). No extension API mints a credential — the consumer never mints, in every surveyed system.
- **Flat, user-owned namespace**: secrets are named (`deploy-key`), owned by the user, granted per extension by scope string. Two extensions granted `credential:deploy-key` share it — the owner's choice, stated in two consent sentences.
- **Unknown ref is a loud typed refusal**: `{ ok: false, reason: "unknown_credential" }`, recorded as `host_refused`. A ref that does not resolve is an owner-side configuration error and must be visible — the GitHub-style silent-empty-string resolution contradicts ADR-0005's no-silent-fallbacks rule.
- **Composition with `host:<domain>`** (per ADR-0066): the host scope alone makes anonymous requests; an authenticated request needs both scopes — the intersection of two grants, each visible in consent.
- **Redaction**: reference indirection sidesteps the problem for these secrets — the plaintext never enters the log surface. ADR-0058's unconditional pass remains in force for anything arriving by other paths. Credential *names* are not secrets and appear in consent, log and manifest.
- **Log**: `host_op` carries the ref name, never a value; the injection itself is not an event — the `fetch`'s `host_op` shows `credential: "deploy-key"` as a parameter.

## Considered options

- Extension-readable secret API — rejected: the one rule every surveyed host enforces.
- Per-extension namespacing — rejected: moves ownership from the user to the extension and hides who shares what.
- Silent absence for unknown refs — rejected: hides owner-side misconfiguration.

## Consequences

All five scope arcs of the host-performs phase are now resolved (0065–0068, custody here). #1152 (phases and migration) is unblocked and sequences the implementation.

## Amendment (#1178): keychain accounts are home-scoped

The keychain is user-global while `home` is an assembly-level parameter. The first implementation keyed items by service `moh-secret` and account = the bare ref, so a temporary home — a test, a lane — resolved the ambient user's secret and an extension whose activation switch is "a stored credential exists" (Jev) activated where no key exists, with a real credential reachable from a sandboxed home. The account now carries a digest of the home (`sha256(home)[:16]:ref`, `keychainAccount`): two homes on one machine can never read each other's secrets, and activation is always evaluated against the assembly's own home. Items written before this amendment (bare-ref accounts) are honored only from the ambient real user home — a legacy fallback on `get`, cleanup on `delete` — never from a temporary home.

## Amendment — ablation (2026-10-19)

The decision above is unchanged. This amendment records where the `credential:` scope and the credential stores live after #1424 (S3.2, delivered by #1571), the prerequisite recorded for this ADR. It adds no decision.

### What changed

- Before #1571 both halves were in `packages/core/src/credential-scope.ts`. The scope half: `CREDENTIAL_SCOPE_PREFIX`, `isCredentialScope`, `credentialScopeRef`, `validateCredentialScope`, `credentialScopesOf` and the effect-sentence function `credentialEffectSentence`, all exported. The store half: `CredentialStore`, `keychainAccount`, `keychainCredentialStore`, `defaultCredentialStore` and `fileCredentialStore` were exported; `SECRETS_FILE` was not.
- There was no `checkCredentialScope` function. The check for a `credential` request was written inline in the `credential` case of `checkScope` in `packages/core/src/check-scope.ts`, and `packages/core/src/scope-effect.ts` called `credentialEffectSentence(credentialScopeRef(…))` for `isCredentialScope` capabilities.
- The scope half is now in `packages/core/src/scopes.ts`. `CREDENTIAL_SCOPE_PREFIX`, `isCredentialScope`, `credentialScopeRef`, `validateCredentialScope` and `credentialScopesOf` are still exported from there; `credentialEffectSentence` lost its `export` and is file-local. The former inline check is the `check` of the `credential` descriptor in the scope table, with the same text, and the descriptor's `effectSentence` calls `credentialEffectSentence(credentialScopeRef(…))`. For `checkScope` itself, see the amendment to ADR-0064.
- The store half is now in `packages/core/src/credential-store.ts`, with the same names and the same exports; `SECRETS_FILE` is still not exported. Git records `credential-scope.ts` as renamed to `credential-store.ts`. `credential-scope.ts`, `check-scope.ts` and `scope-effect.ts` no longer exist.
- The `@moh/core` entry (`packages/core/src/index.ts`) keeps the same names: `validateCredentialScope` now comes from `./scopes`, and `defaultCredentialStore` and `type CredentialStore` from `./credential-store`.

### What stays

- The rules in the Decision section are unchanged. Compared line by line, with comments, blank lines, whitespace and the `export` keyword removed, the declarations and function bodies of the old `credential-scope.ts` and those of the credential part of `scopes.ts` plus `credential-store.ts` are the same (237 lines on each side); the only difference in order is the file header and imports, which sit at the top of `credential-store.ts`. The storage (macOS Keychain, with the `0600` file fallback), the home-scoped keychain account of the amendment above (`keychainAccount`) and the custody are therefore as before.
- The refusal reasons are unchanged, and each is still produced where it was. `validateCredentialScope` returns `malformed`, which the extension loader in `extensions.ts` reports as `invalid_credential_scope`. The `credential` check returns `outside_scope`. `unknown_credential` is returned by the `ctx.host.fetch` path in `extensions.ts` when the credential store holds no value for the ref (`credentialStore?.get(ref)` is `undefined`).
- The effect sentence is unchanged: "may use the credential `<ref>`".
- `scope-effect.ts` carried the comment "ADR-0069: the credential scope's sentence lives in its own module; this single renderer stays the one consent reads." #1571 removed it by coordinator decision, because it described the old file structure.
- A `credential:` scope with a malformed ref is still accepted by the `credential` check of `checkScope`; this is tracked separately in #1572, not changed by #1571.
