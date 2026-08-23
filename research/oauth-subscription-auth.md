# OAuth subscription-auth flows for AI providers (Claude, ChatGPT, Gemini)

Research for `moh provider add` subscription-based auth. Sources are primary (official docs, official CLI source code, official issue trackers) unless explicitly marked otherwise. Verified against:

- OpenAI Codex CLI source: `openai/codex` branch `main` (fetched 2026-08-23)
- Gemini CLI source: `google-gemini/gemini-cli` branch `main` (fetched 2026-08-23)
- Anthropic: official docs + `anthropics/claude-code` issues, **verified and corrected against the decompiled Claude Code TypeScript source** (`/Users/mc/Documents/AI_Projects/claude-code-main`, local copy; authoritative for all endpoint/client_id/scope/header facts below)

---

## 1. Anthropic (Claude Code OAuth — Claude Pro/Max)

### Endpoints (verified in Claude Code source, `constants/oauth.ts` — `PROD_OAUTH_CONFIG`)

| Item | Value | Source |
|---|---|---|
| Authorization endpoint | `https://claude.com/cai/oauth/authorize` (Pro/Max path; 307-bounces through claude.com for attribution, then to claude.ai/oauth/authorize in two hops) and `https://platform.claude.com/oauth/authorize` (Console path) | source `constants/oauth.ts` (`CLAUDE_AI_AUTHORIZE_URL`, `CONSOLE_AUTHORIZE_URL`) — supersedes the older `claude.ai/oauth/authorize` capture in [issue #36215](https://github.com/anthropics/claude-code/issues/36215) |
| Token endpoint | `https://platform.claude.com/v1/oauth/token` | source `constants/oauth.ts` (`TOKEN_URL`) — **not** `console.anthropic.com` as issue captures suggested |
| client_id | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | source `constants/oauth.ts` (`CLIENT_ID`) — confirmed; also overridable by Claude Code itself via env `CLAUDE_CODE_OAUTH_CLIENT_ID` |
| Scopes | Login requests the union of Console (`org:create_api_key user:profile`) and Claude.ai (`user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`) scopes; an `inferenceOnly` variant requests just `user:inference` for **long-lived inference-only tokens** | source `constants/oauth.ts` (`ALL_OAUTH_SCOPES`, `CLAUDE_AI_OAUTH_SCOPES`, `CONSOLE_OAUTH_SCOPES`, `CLAUDE_AI_INFERENCE_SCOPE`) |
| PKCE | S256: `code_challenge` = base64url(sha256(verifier)), verifier/state = base64url(32 random bytes) | source `services/oauth/crypto.ts`, `client.ts` (`buildAuthUrl`) |
| Redirect URI | Automatic: `http://localhost:<ephemeral port>/callback` (server binds `localhost`, port 0 = OS-assigned). Manual: **hosted** redirect `https://platform.claude.com/oauth/code/callback` (not loopback) | source `services/oauth/auth-code-listener.ts` (`listen(port ?? 0, 'localhost')`), `constants/oauth.ts` (`MANUAL_REDIRECT_URL`) — resolves the [issue #88877](https://github.com/anthropics/claude-code/issues/88877) callback-path confusion |
| Extra params | authorize URL adds `code=true`, optional `login_hint`, `login_method`, `orgUUID`; **token exchange accepts a client-requested `expires_in`** (used for the long-lived inference-only tokens) | source `client.ts` (`buildAuthUrl`, `exchangeCodeForTokens`) |

Anthropic publishes **no** `.well-known/oauth-authorization-server` discovery document on `claude.ai` or `console.anthropic.com` (verified: 404/HTML, 2026-08-23).

### Headers on API calls with OAuth tokens

- `anthropic-beta: oauth-2025-04-20` — **confirmed in source** (`constants/oauth.ts` `OAUTH_BETA_HEADER`), injected whenever the user is a Claude.ai subscriber (`utils/betas.ts`, `utils/http.ts`, `utils/model/modelCapabilities.ts`). Still undocumented at docs.anthropic.com.
- OAuth traffic hits `https://api.anthropic.com` same as API-key traffic; usage metering at `https://api.anthropic.com/api/oauth/usage`; profile (subscription type, rate-limit tier) at `https://api.anthropic.com/api/oauth/profile`; **an OAuth access token can mint an API key** at `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` (same pattern as Codex's RFC 8693 exchange) — source `getOauthProfile.ts`, `client.ts` (`createAndStoreApiKey`).

### Token lifetimes and storage

- Token exchange response: `{ access_token, refresh_token, expires_in (seconds → `expiresAt = now + expiresIn*1000`), scope, account.uuid/email_address, organization.uuid }` — source `client.ts` (`formatTokens` in `index.ts`). Exact lifetime value is server-chosen (issue #61912 observed ~hours); the client also supports requesting a custom `expires_in` for long-lived inference tokens.
- **Refresh grant** (`client.ts` `refreshOAuthToken`): JSON POST to `TOKEN_URL` with `{ grant_type: "refresh_token", refresh_token, client_id, scope }` — the backend allows **scope expansion on refresh**, and a new refresh token may be returned (fallback: keep the old one). Profile re-fetch on refresh is skipped when cached subscription data exists.
- The full login (refresh token chain) expires periodically; official docs describe the client behavior: warning "Your login expires in 3 days · run /login to renew" within 3 days of expiry (v2.1.203+), hard failure "Login expired · Please run /login" after expiry, `/status` shows login state. Source: [IAM docs — "Renew an expiring login"](https://docs.anthropic.com/en/docs/claude-code/iam).
- Storage: `~/.claude/.credentials.json` (macOS: Keychain; Linux/WSL: file) — file path confirmed in [issue #61912](https://github.com/anthropics/claude-code/issues/61912); Keychain behavior is community-known but consistent with the issue ("credentials state... persists across sessions"). **Keychain detail unverified from a primary source.**

### Headless / manual paste fallback (official)

From the [IAM docs](https://docs.anthropic.com/en/docs/claude-code/iam): "If the browser doesn't open automatically, press `c` to copy the login URL to your clipboard, then paste it into your browser. If your browser shows a login code instead of redirecting back after you sign in, paste it into the terminal at the `Paste code here if prompted` prompt." **Mechanics (source `services/oauth/index.ts`)**: Claude Code runs *both* flows concurrently — it shows the manual URL to the user *and* tries `openBrowser()` on the automatic loopback URL; whichever delivers a code first wins (the manual redirect lands on the hosted `platform.claude.com/oauth/code/callback` page, which displays a code to paste back; the automatic one redirects to the local listener). `skipBrowserOpen` hands both URLs to the caller (SDK control-protocol use). Known operational hazard: [issue #47754](https://github.com/anthropics/claude-code/issues/47754) — Cloudflare WAF can block OAuth refresh from headless Linux servers.

---

## 2. OpenAI (Codex CLI login — ChatGPT Plus/Pro)

All facts below are from `openai/codex` source on `main` (Apache-2.0), files under `codex-rs/login/src/`.

### OAuth endpoints, client_id, scopes, PKCE

| Item | Value | Source file |
|---|---|---|
| Issuer | `https://auth.openai.com` (`DEFAULT_ISSUER` in `codex-rs/login/src/server.rs`) | [server.rs](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs) |
| Authorization endpoint | `{issuer}/oauth/authorize` → `https://auth.openai.com/oauth/authorize` | `build_authorize_url()` in server.rs |
| Token endpoint | `{issuer}/oauth/token` → `https://auth.openai.com/oauth/token` | `exchange_code_for_tokens()` in server.rs; also `REFRESH_TOKEN_URL` in `auth/manager.rs` |
| Revoke endpoint | `https://auth.openai.com/oauth/revoke` (`REVOKE_TOKEN_URL`) | [auth/manager.rs](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs) |
| client_id | `app_EMoamEEZ73f0CkXaXp7hrann` (`CLIENT_ID` const, manager.rs:1678); overridable via env `CODEX_APP_SERVER_LOGIN_CLIENT_ID` | auth/manager.rs |
| Scopes | `openid profile email offline_access api.connectors.read api.connectors.invoke` | `build_authorize_url()` in server.rs |
| PKCE | S256; random 32-byte URL-safe-nopad `state` | server.rs (`generate_pkce`, `generate_state`) |
| Redirect URI | `http://localhost:{port}/auth/callback`; default port **1455**, fallback **1457** if 1455 busy (after trying to cancel a stale server via `GET /cancel`) | server.rs (`DEFAULT_PORT`, `FALLBACK_PORT`, `bind_server`) |
| Extra authorize params | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=codex_cli_rs`, optional `allowed_workspace_id` | server.rs + `auth/default_client.rs` (`DEFAULT_ORIGINATOR = "codex_cli_rs"`) |

Device-code flow (headless): [device_code_auth.rs](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs) — POST `{issuer}/deviceauth/usercode` with `{client_id}`, then poll `{issuer}/deviceauth/token` with `device_auth_id` + `user_code` until an `authorization_code` (+ PKCE verifier) is returned, then normal code exchange. Note this is a custom protocol, not RFC 8628 endpoints.

### Token exchange → API key

After the code exchange, Codex performs an RFC 8693 token exchange at the same `/oauth/token` endpoint (server.rs, `obtain_api_key()`): `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `requested_token=openai-api-key`, `subject_token=<id_token>`, `subject_token_type=urn:ietf:params:oauth:token-type:id_token` → returns an API-key-shaped `access_token`. So even in ChatGPT mode, `auth.json` may contain an `openai_api_key` field.

### auth.json format and storage

`$CODEX_HOME/auth.json` (default `~/.codex/auth.json`), or OS keyring (service `KEYRING_SERVICE`, see [auth/storage.rs](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)). Shape (from `AuthDotJson` / `TokenData` in server.rs, manager.rs, [token_data.rs](https://github.com/openai/codex/blob/main/codex-rs/login/src/token_data.rs)):

```json
{
  "auth_mode": "chatgpt",
  "openai_api_key": "<optional, from token exchange>",
  "tokens": {
    "id_token": { /* flattened JWT claims: email, chatgpt_plan_type ("free"|"plus"|"pro"|"business"|"enterprise"|"edu"), chatgpt_user_id, chatgpt_account_id, chatgpt_account_is_fedramp, raw_jwt */ },
    "access_token": "<JWT>",
    "refresh_token": "...",
    "account_id": "<chatgpt_account_id claim>"
  },
  "last_refresh": "<RFC3339 timestamp>"
}
```

ID-token claims live under namespaced keys `https://api.openai.com/profile` and `https://api.openai.com/auth` (token_data.rs `IdClaims`).

### ChatGPT-plan vs API-key mode: backend endpoints

- ChatGPT mode (`auth_mode: "chatgpt"`) → base URL **`https://chatgpt.com/backend-api/codex`** (`CHATGPT_CODEX_BASE_URL`, [model-provider-info/src/lib.rs:40](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)); API-key mode → `https://api.openai.com/v1`. Wire API is "responses" in both cases.
- ChatGPT mode sends `originator` header (`codex_cli_rs` default) and identifies the workspace via the `chatgpt_account_id` (e.g. workspace-restricted login and workspace checks in server.rs `ensure_workspace_allowed`). FedRAMP accounts route to a FedRAMP edge (token flag `chatgpt_account_is_fedramp`).
- Official user-facing doc for both sign-in modes: [developers.openai.com/codex/auth](https://developers.openai.com/codex/auth) — "Sign in with ChatGPT for subscription access / Sign in with an API key for usage-based access".

### Refresh semantics

- Background refresh: if `last_refresh` older than **8 days** (`TOKEN_REFRESH_INTERVAL`), refresh proactively (manager.rs:185, 2901–2905).
- Access-token refresh: refresh if the JWT expires within **5 minutes** (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`, manager.rs:186); refresh grant: JSON POST `{client_id, grant_type: "refresh_token", refresh_token}` to `https://auth.openai.com/oauth/token` (manager.rs ~1556). Overridable via `CODEX_REFRESH_TOKEN_URL_OVERRIDE`.
- Refresh failures are classified (expired/reused/revoked/account-mismatch) with user-facing re-login messages (manager.rs:188–193). On 401 mid-request there is a recovery chain: reload auth.json → refresh token → external refresh (`UnauthorizedRecoveryStep`, manager.rs:1924+).

---

## 3. Google (Gemini CLI — personal Google account)

All facts from `google-gemini/gemini-cli` source on `main` (Apache-2.0), mainly [packages/core/src/code_assist/oauth2.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts).

### Client credentials, endpoints, scopes

| Item | Value | Source |
|---|---|---|
| client_id | `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com` | oauth2.ts `OAUTH_CLIENT_ID` |
| client_secret | `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` — embedded intentionally; per Google's own OAuth-for-installed-apps guidance the secret "is obviously not treated as a secret" (comment cites developers.google.com/identity/protocols/oauth2#installed) | oauth2.ts `OAUTH_CLIENT_SECRET` |
| Endpoints | Standard Google OAuth via `google-auth-library` `OAuth2Client.generateAuthUrl()`/`getToken()` → `https://accounts.google.com/o/oauth2/v2/auth` and `https://oauth2.googleapis.com/token` (library defaults; gemini-cli does not override them — **endpoint URLs themselves come from the library, not the repo**) | oauth2.ts |
| Scopes | `https://www.googleapis.com/auth/cloud-platform`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` | oauth2.ts `OAUTH_SCOPE` |
| access_type | `offline` (returns refresh_token) | oauth2.ts |

### Two flows

1. **Browser flow** (`authWithWeb`): ephemeral port (`net.createServer().listen(0)`, overridable via `OAUTH_CALLBACK_PORT`; bind host via `OAUTH_CALLBACK_HOST`, default `127.0.0.1`) → redirect URI `http://127.0.0.1:{port}/oauth2callback`. Comment in code: redirect URI "MUST use a loopback IP literal... strict security policy for credentials of type 'Desktop app'". No PKCE in this path (PKCE only in the manual path) — the code uses random `state` for CSRF. 5-minute timeout; SIGINT/Ctrl+C cancellation; success/failure redirect users to `https://developers.google.com/gemini-code-assist/auth_success_gemini` / `.../auth_failure_gemini`.
2. **Manual paste flow** (`authWithUserCode`, used when browser launch is suppressed / `NO_BROWSER=true`): redirect URI is the out-of-band page **`https://codeassist.google.com/authcode`**; PKCE S256 (`generateCodeVerifierAsync` + `code_challenge_method: S256`); prints the authorize URL, user opens it anywhere, then pastes the authorization code back into the terminal (readline, 5-min timeout, 2 retries).

### Code Assistant API endpoint

- **`https://cloudcode-pa.googleapis.com`**, API version `v1internal` → requests like `POST {base}:generateContent` / `:generateContentStream` ([code_assist/server.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts): `CODE_ASSIST_ENDPOINT`, `CODE_ASSIST_API_VERSION = 'v1internal'`; overridable via `CODE_ASSIST_ENDPOINT` / `CODE_ASSIST_API_VERSION` env). Auth = standard `google-auth-library` bearer-token attach; the library refreshes access tokens automatically using the stored refresh_token.

### Token storage

- Newer versions: OS keychain, service name **`gemini-cli-oauth`** ([code_assist/oauth-credential-storage.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth-credential-storage.ts) `KEYCHAIN_SERVICE_NAME`), with automatic migration from the legacy file.
- Legacy file: `~/.gemini/oauth_creds.json` (`OAUTH_FILE` in [config/storage.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/storage.ts), `GEMINI_DIR = '.gemini'`); content is the google-auth-library `Credentials`/`JWTInput` shape (client_id, client_secret, refresh_token, `type: "authorized_user"`).

### Refresh & headless

- `access_type: 'offline'` + google-auth-library auto-refresh before each request (standard library behavior; not custom code).
- Headless: `NO_BROWSER=true` forces `authWithUserCode` (manual paste). Non-interactive + NO_BROWSER → hard error telling the user to use `GEMINI_API_KEY` or ADC (oauth2.ts, `initOauthClient`).

---

## 4. Cross-cutting patterns

### Local HTTP callback server

- **Bind loopback only** (`127.0.0.1`, never `0.0.0.0` unless explicitly overridden — gemini-cli's `OAUTH_CALLBACK_HOST` exception noted). Codex binds `127.0.0.1:1455` (fallback 1457, registered in the server's redirect-URI allowlist); Anthropic and Google use ephemeral ports (Google's comment explains: loopback IP literal required by Google policy for "Desktop app" clients). Ephemeral port + loopback is the safest default; fixed ports only when the provider's allowlist demands them (Codex).
- Always: random `state` (≥32 bytes) validated on callback; PKCE S256 everywhere except Google's browser path (state-only there); serve a small success/cancel page and shut the server down immediately after the code arrives.
- Codex's stale-server trick is worth copying: if the port is busy, send `GET /cancel` to the previous login server and retry.

### Manual paste fallback for headless (SSH/VPS)

Three distinct patterns observed:
1. **Anthropic**: copy authorize URL (press `c`), open on any browser, paste the resulting code back ("Paste code here if prompted") — official docs behavior. Redirect URI stays loopback; the browser shows a code when it can't reach localhost.
2. **OpenAI**: custom device-code protocol (`/deviceauth/usercode` + polling) — no local server at all; also fine for SSH. Alternatively copy the localhost callback URL.
3. **Google**: dedicated out-of-band redirect page `https://codeassist.google.com/authcode` that displays the code for pasting, with PKCE S256.

### Refresh-before-request

- Codex: proactive refresh if `last_refresh` > 8 days, or access token expiring within 5 minutes; plus 401-recovery chain (reload → refresh → fail with classified message). This is the most robust reference pattern.
- Google: library-managed (google-auth-library refreshes on demand, with retries).
- Anthropic: reactive refresh on 401/expiry, known failure modes ([#61912](https://github.com/anthropics/claude-code/issues/61912) refresh corruption on 5xx; [#47754](https://github.com/anthropics/claude-code/issues/47754) WAF blocks on headless Linux) — mirror Codex's pattern instead, and handle refresh-token reuse/revocation errors by forcing re-login.

### Subscription vs API-key rate limits

- **Anthropic Pro/Max**: usage limits shared between Claude chat and Claude Code; on hitting limits you can wait for reset, buy usage credits, or switch to Console API credits (billed at API rates); `/status` and `/usage` show plan usage. Source: [Help Center: Use Claude Code with your Pro or Max plan](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan), [Claude Code costs doc](https://docs.claude.com/en/docs/claude-code/costs). Weekly/session reset cadence is described in [Help Center: usage limits](https://support.anthropic.com/en/articles/8325612-how-do-usage-and-length-limits-work) — **the exact 5-hour/weekly window figures are client-side rendered and could not be extracted here; treat specific numbers as unverified until read in the article.** Issue [#30930](https://github.com/anthropics/claude-code/issues/30930) shows the OAuth usage endpoint `api.anthropic.com/api/oauth/usage` exists for metering.
- **OpenAI**: plan-tier enforcement happens server-side at `chatgpt.com/backend-api/codex`; the id_token carries `chatgpt_plan_type` (free/plus/pro/business/enterprise/edu) and rate-limit responses are plan-dependent. Official statement of the two modes: [developers.openai.com/codex/auth](https://developers.openai.com/codex/auth). Specific per-plan quotas: **not published in the codex repo; unverified from primary sources here.**
- **Google**: personal-account Gemini CLI has its own (separate, smaller) quota model vs AI Studio API keys; the rate-limit values are server-side and not in the repo — **unverified**.

---

## Confidence & caveats

1. **Strongest (verbatim source code)**: all OpenAI Codex and Google Gemini CLI facts — both repos are open source; cite by file and line as pinned above. They can drift with each release; re-pin before implementing.
2. **Anthropic is the weakest link — now much less weak**: the local Claude Code source (`constants/oauth.ts`, `services/oauth/*`) gives us first-party truth for endpoints, client_id, scopes, PKCE, the `oauth-2025-04-20` beta header, the hosted manual-redirect page, the profile/usage/create_api_key endpoints, and refresh semantics (scope expansion, rotating refresh tokens). Remaining risks: Anthropic can rotate hosts/client_id without notice (they already bounced claude.ai → claude.com/cai → platform.claude.com), there is still no published discovery document, and the source is a local decompiled snapshot — re-verify against a fresh copy at implementation time.
3. **ToS-gray area — reusing official CLI client_ids**: implementing a third-party `moh provider add` that impersonates Claude Code (`9d1c250a-...`) or Codex (`app_EMoamEEZ73f0CkXaXp7hrann`) reuses a registered OAuth client. Google explicitly blesses embedded installed-app secrets (their docs treat them as non-secrets), but Anthropic's and OpenAI's clients were registered for their own apps; subscription-plan usage through a coding agent is arguably permitted for the named CLIs but **using their client_ids from another binary is not covered by any published terms** and providers could block the client or the accounts. Flag this in the ADR; consider requiring users to accept a warning during `moh provider add`.
4. **Rate-limit numbers**: subscription quotas (Claude Pro/Max windows, ChatGPT plan quotas, Gemini free-tier quotas) change frequently and are mostly published in help-center pages, not specs. The architectural lesson (plan-aware backoff, usage endpoints, re-login UX) is stable; the numbers are not.
5. **Drift watch**: Codex now also supports PAT login, keyring storage, and FedRAMP routing (see manager.rs exports); Gemini CLI migrated to keychain storage with file migration; Anthropic rotated OAuth hosts (`claude.ai` ↔ `platform.claude.com`, [#71766](https://github.com/anthropics/claude-code/issues/71766)). Design `moh provider add` to store issuer/endpoint URLs as configuration, not constants.
