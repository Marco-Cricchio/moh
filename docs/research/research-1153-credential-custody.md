# research-1153 — Credential custody: how host applications store, reference, and redact secrets their extensions/agents touch

Prior art for wayfinder ticket #1153 (child of map #996). Primary sources only: each claim carries one URL.
This file extends, and deliberately does not repeat, `research-997/997-D1-prior-art-agent-clis.md` (which covers *acquisition* of credentials by agent CLIs) and `research-997/997-D2-prior-art-platforms.md` (which covers *capability declaration* in plugin platforms). The gap it fills: what happens to a credential *after* it exists — where it lives, how it is addressed without being exposed, who can create/rotate/revoke it, and how hosts keep it out of logs.

Verification status: every URL below was fetched live and returned readable content at the canonical URL shown, unless explicitly marked **UNVERIFIED**. Quoted English is verbatim from the page cited. The `research-997/` directory on this branch was copied from the local untracked tree of the main checkout, per the resolution note on #997 — it is included here only so `997-D1`/`997-D2` remain citable on this branch.

---

## 1. Storage models: where the credential lives

Three storage models appear across the surveyed hosts, in decreasing order of isolation from plugin/agent code.

### 1.1 OS keychain / encrypted store (VS Code, Claude Code on macOS)

VS Code gives extensions a purpose-built secret store, distinct from ordinary state storage, and the docs are explicit that this store is *encrypted* and *not synced*:

> "A global storage for secrets (or any information that is sensitive) that will be encrypted. These are not synced across machines. For VS Code desktop, this leverages Electron's safeStorage API. For VS Code for the Web, this uses a Double Key Encryption (DKE) implementation."
> — <https://code.visualstudio.com/api/extension-capabilities/common-capabilities.md> (Data Storage section, item `ExtensionContext.secrets`)

The same page enumerates the alternatives that are *not* secret stores, making the boundary visible by contrast: `workspaceState`, `globalState`, `storageUri`, `globalStorageUri` are all described as plain key/value or file stores, with no encryption language attached. Only `secrets` carries the word "encrypted". This is a host drawing a hard line between "state" and "secret" at the API-surface level.

Claude Code does the same thing outside an extension API, as a CLI holding its own login credentials, and — importantly for headless deployments — documents a fallback when the OS keychain is not available:

> "On macOS, credentials are stored in the encrypted macOS Keychain. When the Keychain rejects the write, such as when it's locked in an SSH session, Claude Code stores your login in `~/.claude/.credentials.json` with file mode `0600` instead, the same storage it uses on Linux."
> "On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`."
> "On Windows, credentials are stored in `%USERPROFILE%\.claude\.credentials.json` and inherit the access controls of your user profile directory, which restricts the file to your user account by default."
> "If you've set the `CLAUDE_CONFIG_DIR` environment variable, Claude Code keeps the `.credentials.json` file under that directory instead … and keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry."
> — <https://code.claude.com/docs/en/authentication.md> (Credential management section)

The headless/CI fallback model is explicit and bounded: keychain when available, plaintext file with `0600` when not, with the *fallback, not the keychain, being the thing that fails hard* in one specific case ("A Console login that creates an API key fails until the Keychain is writable") — i.e. the host refuses a flow rather than silently storing a newly-minted credential in plaintext.

### 1.2 Plaintext file + file permissions (Claude Code on Linux/Windows, the universal fallback)

Same source as above. The Linux/Windows case *is* the fallback model, and the host treats it as a first-class storage tier, not an error: it works, it is scoped to the user by `0600` / profile-dir ACL, and it is what ships by default on any OS where a keyring daemon is not running. No surveyed host refuses to function because no keyring exists; they degrade to file+permissions.

### 1.3 Host-managed vault, referenced not stored (1Password, GitHub Actions, AWS)

The third model does not store the secret in the agent host at all. The host holds only a *reference*, and the value lives in an external vault whose access is separately governed.

1Password's reference URI is the purest example — a string that names where the secret lives without containing it:

> "Secret reference URIs point to where a secret is saved in your 1Password account using the names (or unique identifiers) of the vault, item, section, and field where the information is stored.
> `op://<vault-name>/<item-name>/[section-name/]<field-name>`"
> "Secret references remove the risk of exposing plaintext secrets in your code and reflect changes you make in your 1Password account, so when you run a script you get the latest value."
> — <https://developer.1password.com/docs/cli/secret-reference-syntax/>

Two properties are stated outright and matter for moh: the reference *removes the risk of exposing plaintext in code*, and it *reflects changes* — rotation is automatic because the reference is resolved at read time, not baked in.

GitHub Actions is the same shape from the platform side: the secret value is created once in the host UI/CLI and workflows reference it by name via the `secrets` context, never storing it in the repo:

> "To create secrets or variables on GitHub for an organization repository, you must have `write` access. For a personal account repository, you must be a repository collaborator."
> — <https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets> (Creating secrets for a repository)

### 1.4 Headless / CI long-lived tokens (Claude Code)

For environments where interactive login isn't possible, Claude Code issues a deliberately-scoped token the user copies into a CI secret — it is *not* stored by the CLI itself:

> "The command opens the same browser authorization flow as `/login`, and the token prints to the terminal after you approve access in the browser. **It does not save the token anywhere**; copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate."
> — <https://code.claude.com/docs/en/authentication.md> (Generate a long-lived token)

This is a fourth storage model in effect: *the host refuses to store it at all* and hands custody to a CI secrets store, which is a 1.3-class system. The token is also capability-restricted ("It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors"), which is a narrow, explicitly-enumerated scope, not a standing login.

---

## 2. Reference indirection: addressing a secret without holding it

### 2.1 The reference itself is safe to commit

1Password's design goal, stated on the reference-syntax page, is exactly the property a plugin/extension platform wants from a pointer:

> "Secret references remove the risk of exposing plaintext secrets in your code"
> — <https://developer.1password.com/docs/cli/secret-reference-syntax.md>

Supporting details, same page:
- The reference can embed *environment switches* inside the URI (`op://$APP_ENV/mysql/database`), so one checked-in config serves dev/staging/prod without any secret material in it.
- File attachments and SSH keys are addressable the same way, with format negotiation by query parameter (`?ssh-format=openssh`, `?attribute=otp`, `?attribute=type`), so the *type* of secret is also carried by the reference, not guessed by the consumer.

### 2.2 Host-side injection (GitHub Actions)

The host resolves the reference at the last moment, inside the runner, and the workflow file never contains the value:

> "To provide an action with a secret as an input or environment variable, you can use the `secrets` context to access secrets you've created in your repository."
> — <https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets> (Using secrets in a workflow)

The host also *withholds* secrets from contexts that have not earned them:

> "With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is triggered from a forked repository."
> "Secrets are not automatically passed to reusable workflows."
> "Secrets are not available to workflows triggered by Dependabot events."
> — same page, the note block under "Using secrets in a workflow"

This is the injection equivalent of moh's spawn envelope (`research-997/997-D2`, §5 "Spawn envelope"): a reference without a matching grant produces not a value but an empty string ("If a secret has not been set, the return value of an expression referencing the secret … will be an empty string", same page) — absence is silence, not an error or a fallback to a default.

### 2.3 Value never returned to plugin code (VS Code, by omission of any read API)

VS Code's authentication namespace, as documented on the API reference page, offers `getSession` — which returns a session object, not a raw token — and `getAccounts`, with an explicit warning that listing accounts is not access:

> "Note: Getting accounts does not imply that your extension has access to that account or its authentication sessions. You can verify access to the account by calling getSession."
> — <https://code.visualstudio.com/api/references/vscode-api> (authentication.getAccounts)

The session object carries the *fact* of authentication, and the host is the party that uses it for network calls. Extensions do not read a token string out of a store and attach it to their own requests; the shape of the API makes that path not exist. This is the injection mechanism at its strongest: not "here is the secret, use it carefully" but "here is a session, the host will speak on your behalf."

**UNVERIFIED (flagged for follow-up):** the `SecretStorage` interface body in `vscode.d.ts` was not reached in this pass, so whether extensions can *read back* a secret they wrote (as opposed to only host-mediated auth sessions being readable) is unresolved. The Common Capabilities page confirms `ExtensionContext.secrets` exists and is encrypted, but not the read/write split between extension-owned and host-owned secrets. This is the one cell in the matrix that needs a targeted grep on `vscode.d.ts` before the ticket's design discussion.

---

## 3. Creation & namespacing: who mints the credential, and in whose namespace

### 3.1 User (or CI admin) mints; consumer only references

Across 1Password, GitHub Actions, and Claude Code's CI-token flow, the *user* (or an org admin) is the party that creates the secret, in the user's own namespace:

- 1Password: the user copies the reference out of their own vault, via the desktop app, the VS Code extension, or `op item get`. The vault is the namespace, and it is the user's, not the script's. (<https://developer.1password.com/docs/cli/secret-reference-syntax/>)
- GitHub Actions: "To create secrets or variables on GitHub for an organization repository, you must have `write` access." The creator needs repo write; the *consumer* (a workflow file) needs nothing but the name. (<https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets>)
- Claude Code CI: the user runs `claude setup-token` interactively, in a browser, and copies the result into their CI store. The CLI never persists it. (<https://code.claude.com/docs/en/authentication.md>)

No surveyed host gives the *extension/plugin/agent* a first-party API to mint a new credential in the user's name. The closest is `authentication.registerAuthenticationProvider` (VS Code), which lets an extension *become* a provider — a different role, not a grant to self-issue tokens for someone else's service.

### 3.2 Namespacing is per-vault / per-org / per-config-dir, not per-consumer

- 1Password namespaces by vault → item → section → field, and supports arbitrary user-side grouping (sections) without any host involvement.
- GitHub Actions namespaces by repo → environment → org, with a *policy* layer on the org tier: "Organization-level secrets and variables are not accessible by private repositories for GitHub Free" and org secrets carry a "Repository access" allowlist. (<https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets>)
- Claude Code namespaces by `CLAUDE_CONFIG_DIR`, which *also* keys the macOS Keychain entry: "a session with a different `CLAUDE_CONFIG_DIR` reads a different entry" — so the isolation boundary is directory-level, not process-level, and two concurrent logins on one machine stay separate. (<https://code.claude.com/docs/en/authentication.md>)

The pattern across all three: the *consumer* of a secret is never the namespace owner. Namespacing is a user/host-side concern, and the consumer addresses into it by reference.

---

## 4. Revocation & rotation

### 4.1 Reference-based systems: rotation is a property of the reference, not an action

1Password states this outright:

> "…reflect changes you make in your 1Password account, so when you run a script you get the latest value."
> — <https://developer.1password.com/docs/cli/secret-reference-syntax.md>

Revocation is implicit: delete or move the item in the vault and the reference stops resolving. No "rotate the config file" step exists, because the config file never held the value.

### 4.2 Vault/platform-side rotation

GitHub Actions exposes an update path through the same UI/CLI used to create (`gh secret set` overwrites), and org secrets carry an inspectable access policy ("The list of secrets includes any configured permissions and policies… click Update"), which is the revocation surface — narrow the allowlist and the secret stops flowing to repos it used to reach. (<https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets>)

### 4.3 Session-based rotation with an explicit expiry

Claude Code surfaces rotation to the user as a first-class state, not a silent background event:

> "When the login you created with `/login` is within three days of expiring, Claude Code shows a warning at startup: `Your login expires in 3 days · run /login to renew`. … The warning is informational and never blocks a request: authentication keeps working until the login actually expires. Once the stored login expires and can't be refreshed, each model request fails with `Login expired · Please run /login`."
> "Renewing early matters most for sessions that run unattended. A background session in agent view or a Remote Control session that outlives the login stops making progress once the credential expires and can't recover until you sign in again."
> — <https://code.claude.com/docs/en/authentication.md> (Renew an expiring login)

Two design notes worth carrying: (a) expiry is *visible in advance*, not discovered at failure time, via a status surface (`/status` shows `Expired — log in again`); (b) the failure mode for unattended sessions is explicitly "stops making progress", i.e. the host refuses to silently substitute a different credential path when the standing one dies — which is the same "no silent fallbacks" principle moh applies to config loading (ADR-0005).

### 4.4 Revocation of a login by the user

Claude Code's `/logout` is the documented revocation door, and it is destructive and specific: "Logging out also resets your first-launch setup state"; "run `/logout`, which removes and revokes the credential this sign-in wrote." Revocation and removal-from-storage are the same action, not two. (<https://code.claude.com/docs/en/authentication.md>)

---

## 5. Redaction around secret material

### 5.1 Host-side, unconditional log masking (GitHub Actions)

> "Mask all sensitive information that is not a GitHub secret by using `::add-mask::VALUE`. This causes the value to be treated as a secret and redacted from logs."
> — <https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets>

The design shape: the *host* owns redaction, the *workflow author* declares what counts, and the redaction is unconditional once declared — there is no "disable masking" flag. This matches moh's ADR-0058 ("No opt-out exists. No config key, flag, or consent can disable the pass", `docs/adr/0058-secret-redaction-session-log-writer.md`) and is worth noting as independent corroboration that a no-opt-out redaction layer is a normal platform choice, not an unusual one.

GitHub also flags the boundary of the guarantee honestly — redaction only covers what the host was told about:

> "Be careful that your secrets do not get printed when your workflow runs. When using this workaround [storing large secrets as GPG-encrypted files], GitHub does not redact secrets that are printed in logs."
> — same page, "Storing large secrets"

### 5.2 The value never enters the log in the first place (reference indirection)

The strongest redaction is non-persistence of the plaintext: in the 1Password and GitHub Actions models, the value flows from vault → runner/CLI process → target service, and the only thing the *configuration file or workflow file* ever recorded was the reference. moh's ADR-0058 solves the same problem after the fact (a pass over every event payload at write time, with `sk-…`/`Bearer …`/`AKIA…`/PEM patterns and secret-shaped keys), which is the right answer when secrets can arrive through tool output — the surveyed hosts avoid needing a pattern layer for *their own* credentials by never persisting them in the first place, and still ship a mask layer for *user* secrets that might leak through logs.

---

## 6. Implications for moh's credential scope

Facts only, no decision. Each item is a pattern observed in a cited source, not a recommendation.

- **A "secret" store is a distinct API surface, not a config field.** VS Code splits `globalState` (plain) from `ExtensionContext.secrets` (encrypted) at the type level; the word "encrypted" appears on exactly one of the five storage options. (§1.1)
- **Keychain with an explicit, bounded plaintext fallback is the shipped pattern for CLIs.** Claude Code: macOS Keychain → `~/.claude/.credentials.json` mode `0600` → `%USERPROFILE%` profile-dir ACL; the fallback is ordinary operation on Linux, not an error path. (§1.1–1.2)
- **One specific flow refuses to run rather than silently fall back.** "A Console login that creates an API key fails until the Keychain is writable" — minting a *new* long-lived credential is the operation that demands the stronger store; reading an existing one does not. (§1.1)
- **References, not values, belong in config.** `op://vault/item/field` and `${{ secrets.NAME }}` are both strings safe to commit; rotation falls out of resolution-at-read-time. (§2.1)
- **Unset reference resolves to absence, not to a default.** `${{ secrets.NOPE }}` → empty string; the host does not substitute a fallback or an error-bearing placeholder. (§2.2)
- **Host-side injection with a grant layer beats hand-off of the value.** GitHub withholds secrets from fork PRs, reusable workflows (unless explicitly passed) and Dependabot events; VS Code's `getSession` returns a session, never a raw token, so the extension never holds the material its requests need. (§2.2–2.3)
- **The consumer never mints.** In every surveyed system, the user or admin creates the secret; the extension/workflow/agent only references it. The one mint-adjacent API (`authentication.registerAuthenticationProvider`) makes the extension a provider, not a beneficiary. (§3.1)
- **Namespacing belongs to the user/host side, keyed by vault, org/repo/environment, or config-dir.** Claude Code's `CLAUDE_CONFIG_DIR` keys even the Keychain entry, making the isolation boundary directory-level and multi-login-safe on one machine. (§3.2)
- **Rotation is either automatic (reference) or surfaced in advance (expiry warning at T-3 days, `/status` row), never a silent background swap.** Unattended sessions fail explicitly ("stops making progress") rather than silently re-authenticating by some other path. (§4.1, §4.3)
- **Revocation and removal-from-storage are one action** (`/logout` "removes and revokes"); GitHub narrows reach by editing the org secret's repository-access policy. (§4.2, §4.4)
- **Unconditional log masking, with the host as enforcer and the author as declarer (`::add-mask::`), is an independent precedent for ADR-0058's no-opt-out redaction; the same page documents the guarantee's boundary honestly — what the host was never told about is not masked.** (§5.1)
- **Reference indirection sidesteps the redaction problem for host-owned credentials entirely** — the plaintext never enters the log surface — while moh's pattern-matching pass (ADR-0058) remains necessary for secrets arriving via tool output that no vault ever mediated. (§5.2)

## 7. UNVERIFIED / gaps

- **UNVERIFIED — `SecretStorage` API shape.** The `vscode.d.ts` fetch truncated before the `SecretStorage` interface; whether extensions can *read back* a secret they wrote (vs. only host-mediated auth sessions being readable) is unresolved. Follow up with a targeted grep on `src/vscode-dts/vscode.d.ts` in the microsoft/vscode repo.
- **UNVERIFIED — Electron `safeStorage` prose.** The page loaded (title/metadata confirmed) but the body was not extracted in this pass; the claim that VS Code's secret store "leverages Electron's safeStorage API" is taken from VS Code's own page, which cites it, not from Electron directly.
- **Not attempted.** AWS Secrets Manager (403 bot-block on `docs.aws.amazon.com` this pass — worth a retry or a different regional mirror); 1Password Credential Broker (announced in a banner on the fetched page — "short-lived access to secrets, without managing service account tokens" — likely relevant to §4 rotation, unfollowed); Zed's extension credential surface (no `/docs/extensions/http` path exists; would need the wasm ABI docs to determine whether extensions can hold secrets at all).
- **Scope note.** `research-997/997-D1` already covers *how agent CLIs acquire* credentials (env vars, command-backed auth, OAuth); this file covers *what happens after acquisition*. The two files are meant to be read together; neither repeats the other.
