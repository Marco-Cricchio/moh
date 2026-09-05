# 0009 — Subscription (OAuth) tokens in a guardian-owned `auth` section, hybrid posture, reused client_ids

Date: 2026-09-02 · Status: accepted (decision 2 amended by #151: OpenAI mint best-effort, ChatGPT-backend fallback) · Refs: tickets #132–#139, `docs/principles.md` (1, 3, 5), ADR-0006 (user-config guardian), internal research notes (local)

## Context

All three built-in providers offer subscription auth users expect (Claude Pro/Max, ChatGPT Plus/Pro, personal Google/Gemini). moh previously knew only API keys. Four decisions from this work are hard to reverse, surprising without context, and the result of real trade-offs; this ADR records them together because they were made together (spec grilling session, owner-confirmed).

## Decision

**1. Token placement: a new `auth` section of `~/.moh/config`, guardian-owned, never merged.** Tokens never touch moh.json, session logs, or events. All reads/writes go through the auth store (`core/src/auth/store.ts`) over the ADR-0006 guardian: atomic temp-file+rename writes, 0600/0700, unrelated keys survive. The `auth` section is structurally excluded from the #129 project/user provider merge — the merge seam reads only `provider`/`endpoints`. The section also holds `auth.overrides` (per-provider client_id / issuer URLs) because Anthropic has already rotated OAuth hosts twice without notice; every captured value is user-overridable and documented as drift-prone.

**2. Hybrid token posture (c) — amended by #151: OpenAI's mint is best-effort.** Anthropic and Google use **native OAuth tokens** (plan limits apply). OpenAI *attempts* to mint an API key via the RFC 8693 token exchange; when the mint succeeds the key rides the existing api-key path unchanged. When it fails (live failure: accounts whose id_token lacks `organization_id` cannot mint; the codex CLI itself tolerates mint failure via `obtain_api_key(...).ok()`), the native OAuth tokens are stored with `grant.minted: false` and streaming goes through the **ChatGPT backend** (`https://chatgpt.com/backend-api/codex`, Responses API wire, `originator` header like codex) — the fallback and the common case for ChatGPT-plan auth. Refresh keeps attempting the re-mint; failure is non-fatal for native grants (and may upgrade a native grant to a minted one). Anthropic minting is explicitly rejected: the minted key bills Console credits, not the Pro/Max plan.

**3. Long-lived inference-only Anthropic tokens, with silent fallback.** Login requests `inferenceOnly` scope plus a client-requested `expires_in` (1 year); if the server rejects or caps that, we fall back silently to default-lifetime tokens under normal refresh-before-stream. Caveat recorded: this is the least-documented behavior in the flow — captured from a decompiled Claude Code snapshot, re-verify against a fresh copy when it drifts.

**4. Reused official CLI client_ids, with a mandatory ToS warning.** moh impersonates Claude Code / Codex / gemini-cli OAuth clients. Google explicitly blesses embedded installed-app secrets; Anthropic's and OpenAI's clients were registered for their own apps and using them from another binary is not covered by any published terms. The accepted posture: hardcoded defaults + user overrides + an explicit warning acknowledged during every subscription flow (`confirmToSWarning`, spec invariant 4). Providers could block the client or the accounts; we do not hide this from the user.

File-only token storage for v1 (no OS keychain) — revisit only if users ask.

## Consequences

- `EndpointProfile` gained `auth: { kind: "api-key" } | { kind: "subscription" }`; absence = api-key, so every existing config and test is untouched (api-key behavior byte-identical, spec invariant 1).
- Refresh is core-owned and transparent: refresh-before-stream within a 5-minute proactive window (`auth/resolve.ts`); never mid-stream (principle 3 intact — a mid-stream auth failure is `ProviderError(auth)` and the route fallback chain applies). Refresh failure carries a `moh provider login <name>` hint; no retry loops.
- `moh provider logout` and successful re-login are the only token deleters/replacers (lifecycle invariant).
- Credential resolution has one seam (`resolveEndpointCredential`), injectable per route for tests; the CLI (`moh provider add|login|logout|status`) and any future TUI wiring are thin clients over `auth/lifecycle.ts` (principle 1).
