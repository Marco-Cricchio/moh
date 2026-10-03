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
