# Spec: Subscription (OAuth) provider auth

Status: agreed · Origin: owner report ("`moh provider add` only supports API keys") + grilling session · Related: `docs/principles.md` (1, 3), ADR-0006 (user-config guardian), research/oauth-subscription-auth.md

## Problem

`moh provider add` (packages/core/src/provider-onboarding.ts) and the credential resolution path (`route.ts`, `envApiKey`) know only API keys: inline or `MOH_ENDPOINT_<NAME>_API_KEY`. All three built-in providers offer subscription-based auth that users expect: Claude Pro/Max, ChatGPT Plus/Pro, personal Google account (Gemini). moh cannot onboard or use any of them.

Additionally, headless machines (SSH to a VPS, no browser, no GUI) are a first-class use case: the flow must complete without a local browser.

## Facts (all verified against primary sources — see research/oauth-subscription-auth.md)

- **Anthropic**: OAuth 2.0 + PKCE S256; authorize `https://claude.com/cai/oauth/authorize`, token `https://platform.claude.com/v1/oauth/token`; client_id `9d1c250a-…` (overridable in Claude Code itself via env — we mirror that); scopes include `user:inference` (an `inferenceOnly` variant with client-requested `expires_in` yields long-lived tokens); API calls need `anthropic-beta: oauth-2025-04-20` when subscriber-authed; refresh grant allows scope expansion and may rotate the refresh token; **headless**: hosted manual-redirect page (`https://platform.claude.com/oauth/code/callback`) raced against the automatic loopback flow.
- **OpenAI**: issuer `https://auth.openai.com`; PKCE S256; callback `http://localhost:1455/auth/callback` (fallback 1457); after code exchange, RFC 8693 token exchange mints an API key; ChatGPT-mode backend `https://chatgpt.com/backend-api/codex`; **headless**: custom device-code flow (`/deviceauth/usercode` + poll).
- **Google**: installed-app OAuth, loopback with ephemeral port or **manual paste** with redirect `https://codeassist.google.com/authcode` (`NO_BROWSER=true`); API `https://cloudcode-pa.googleapis.com/v1internal`.
- **ToS**: reusing the official CLI client_ids is explicitly fine for Google (installed-app), gray for Anthropic/OpenAI. Hardcoded defaults + user-overridable config + an explicit warning during onboarding is the accepted posture (owner decision b).

## Decisions (from grilling — owner-confirmed)

1. **All three providers** get subscription auth, not a subset.
2. **Tokens never touch moh.json.** They live in a **new `auth` section of `~/.moh/config`**, owned by the user-config guardian (ADR-0006: read-modify-write, temp-file + rename, 0600/0700). Structurally excluded from the #129 project/user provider merge — `auth` is never a merge candidate.
3. **Onboarding offers both credential kinds**: `moh provider add` asks auth method first — `api-key | subscription` — then branches. API-key path is unchanged.
4. **Headless is native, per provider**: device-code where the provider offers it (OpenAI), manual paste elsewhere (Anthropic hosted redirect page, Google authcode page). `OnboardingIo` grows: `openUrl(url)` (best-effort, may fail headless) and manual-paste handling via `ask`. In the wizard: show the manual URL *and* try the browser, first code wins (Claude Code's proven pattern).
5. **client_id / issuer URLs: hardcoded defaults, overridable** via user config (`auth.overrides`), because Anthropic has already rotated hosts. Documented as captured-values that drift.
6. **Refresh is core-owned and transparent**: refresh-before-stream when the access token is near expiry (Codex-style proactive window); refresh failure → `ProviderError` kind `auth` with a "run `moh provider login <name>`" hint. No retry loops.
7. **Lifecycle commands**: `moh provider login <name>` (re-auth), `moh provider logout <name>` (drop tokens). Logout is the only token deleter besides successful re-login.
8. **Token posture is hybrid (c)**: native OAuth tokens for Anthropic and Google (plan limits apply); OpenAI mints its API key via the RFC 8693 exchange (mandatory in their flow anyway) and rides the existing api-key path. Anthropic minting is rejected — the minted key bills Console credits, not the Pro/Max plan.
9. **Anthropic uses long-lived inference-only tokens** (`inferenceOnly` + client-requested `expires_in`): less refresh churn. Caveat recorded: least-documented behavior; if the server rejects/limits the long expiry, fall back silently to default-lifetime tokens with normal refresh.
10. **File-only token storage for v1** (0600, guardian-owned). No OS keychain.
11. **`moh provider status`** is in scope: shows per-endpoint auth kind, token expiry, and subscription plan-usage where the provider exposes it (Anthropic `/api/oauth/usage`; OpenAI/Google best-effort).

## Target shape

```
packages/core/src/auth/
  types.ts        — AuthToken, AuthMethodKind, provider-specific grant metadata; zod schemas for the `auth` config section
  store.ts        — token persistence via the user-config guardian (new `auth` section, never merged)
  oauth.ts        — generic PKCE machinery (verifier/challenge/state, loopback callback server, manual-paste race)
  anthropic.ts    — endpoints/params, beta header wiring, refresh, inferenceOnly option
  openai.ts       — device-code + loopback flows, RFC 8693 exchange, refresh
  google.ts       — loopback + manual paste, refresh
```

- `EndpointProfile` gains `auth: { kind: "api-key" } | { kind: "subscription" }` (default api-key; absence = api-key — fully backward compatible).
- `route.ts` credential resolution extends: subscription endpoints resolve the access token from the auth store (with refresh) instead of `envApiKey`.
- The anthropic provider adapter injects `anthropic-beta: oauth-2025-04-20` when the endpoint is subscription-authed.
- Provider-onboarding wizard: auth-method question, subscription branch runs the per-provider flow, connection test unchanged (it exercises the resolved credential, whatever its kind).

## Invariants

1. API-key behavior byte-identical: existing configs, env vars, and tests untouched.
2. Tokens never appear in moh.json, session logs, or events. `moh provider add` output redacts secrets.
3. Guardian guarantees extend to `auth`: atomic writes, 0600, unrelated keys survive.
4. ToS warning shown (and acknowledged) before any subscription flow starts.
5. Principle 3 (single-shot providers) intact: refresh happens before the single `stream` call, never mid-stream; a mid-stream auth failure surfaces as `ProviderError(auth)` and the route's fallback chain applies as usual.

## Delivery

Multi-ticket (this spec → `/to-tickets`): core auth module + store, per-provider grants (one ticket each), onboarding/CLI (add/login/logout/status), refresh integration in route resolution, docs/extending update. ADR-0009 records the token-placement, hybrid-posture, and client_id-reuse decisions.

## Resolved questions (all answered by owner)

1. Posture: **hybrid (c)** — native Anthropic/Google, minted OpenAI.
2. Long-lived inference tokens: **yes**, with silent fallback to default lifetime + refresh.
3. Storage: **file-only** v1, no keychain.
4. Usage surfacing: **in scope** — `moh provider status`.
