# ADR-0010: Four builtin OAuth providers, wire/API separation

- Issue: #159
- Status: accepted
- Date: 2026-06-24

## Context

Four new subscription-capable providers land in moh: **github-copilot**,
**openrouter**, **kimi-coding**, **xai** (primary source: the MIT-licensed
`@earendil-works/pi-ai` 0.84.2 — `auth/oauth/*.js`, `providers/data/*.json`).
Two design questions needed an owner decision before the per-provider
tickets (#160–#163, catalogs #164) could start:

1. **Builtin vs openai-compat profile.** kimi-coding and github-copilot
   speak the `anthropic-messages` wire against non-Anthropic backends, and
   copilot additionally switches wire per model — an `openai-compat`
   profile cannot express any of that.
2. **Wire dispatch.** Until now the AI SDK adapter dispatched on
   `Endpoint.kind`, which conflated *who authenticates* (the provider) with
   *what bytes go on the wire* (the message format).

## Decision

1. The four providers are **builtin provider types in the core registry**
   (`EndpointProfile.type` accepts them; `BUILTIN_PROVIDER_TYPES` grows by
   4), not openai-compat profiles. A provider = auth + backend + catalog;
   the wire is a per-model property the catalog carries.
2. **Wire/API separation**: a new `WireApi` vocabulary
   (`anthropic-messages` | `openai-chat` | `openai-responses` | `google`)
   lives in `core/src/wire.ts`. `wireForKind(kind)` gives the default wire
   for a builtin kind; github-copilot models override it per model via the
   catalog (#164). The AI SDK adapter (`providers/ai-sdk.ts`) dispatches on
   the wire, never on the provider kind.
3. **Auth store reuse**: all four reuse the `auth` section / guardian
   (ADR-0006/0009) unchanged. Grant postures:
   - **openrouter**: no refresh — the code exchange yields a *persistent
     API key*, stored as a minted-key grant (OpenAI posture).
   - **kimi-coding** (RFC 8628 device flow) and **xai** (custom device
     flow): access + refresh tokens, refresh-before-stream like the
     existing grants.
   - **github-copilot**: two-hop token — GitHub OAuth device flow →
     short-lived copilot token; "refresh" = re-run the exchange with the
     stored GitHub token.
4. **client_id reuse posture** (ToS warning copy per provider): copilot
   reuses the official VS Code GitHub App client_id; xai and kimi-coding
   publish client_ids for CLI device flows; openrouter uses its official
   OAuth app. The existing acknowledge-first ToS invariant (spec invariant
   4) applies, with per-provider copy.

## Consequences

- `ProviderKind` and the registry's builtin set grow by 4; resolution maps
  each kind to a default backend base URL and wire.
- `RouteTarget` may carry wire + per-model headers (copilot editor
  headers) — the transport the AI SDK adapter builds comes from the
  target, not from a hardcoded kind switch.
- Auth overrides schemas grow per provider (kimi OAuth host is
  env-overridable in pi and drift-prone everywhere).
- Per-provider implementation, catalogs, and TUI polish stay in the child
  tickets; this ADR records the decision and the shared seams only.

## Amendment — 2026-10-11, #1317 Anthropic's subscription choice leaves the wizard

Anthropic stays a subscription-capable kind: the grant, refresh, quota
probe and the `moh provider login|logout|status` paths are untouched. What
leaves is the **offer** — the `api-key | subscription` question the
onboarding wizard (TUI and `moh provider add`) used to ask, which made the
subscription route look like a supported way to run inference.

Two reasons, in this order:

1. **Terms.** Anthropic reserves subscription OAuth for Claude Code and
   its own clients, and states that third-party applications may not
   route requests through Claude Pro/Max credentials
   (<https://code.claude.com/docs/en/legal-and-compliance>).
2. **It does not work.** Independently of the terms, the route does not
   serve inference: a minimal Bearer probe answers an opaque
   `429 rate_limit_error` on every model, output budget and grant tried,
   and the binding condition is the account's own usage state, not the
   request shape (`research/anthropic-oauth-inference-429.md`).

The withdrawal is one predicate, not a scattered condition:
`offersSubscriptionAuth` (`auth/lifecycle.ts`) narrows
`isSubscriptionKind` by a withheld set, and every door that offers the
choice reads it — both clients' wizards stay free of a provider-specific
`if`. The other six OAuth kinds keep their choice unchanged.

An endpoint that already stores an Anthropic subscription token keeps its
configuration: nothing is converted, deleted, disabled, or called.
Session assembly records one visible `endpoint_auth_withdrawn` chrome
event per open (on resume too — the endpoint is still that way in the
environment the session is resumed in), rendered as a warning in the TUI
and as one stderr line under `moh run`, naming the remedy: add an API-key
endpoint, and drop the stored tokens with `moh provider logout <name>`.

## Amendment — 2026-10-26, #1720 Google's subscription choice leaves the wizard

Google stays a subscription-capable kind, exactly like Anthropic after
#1317: the grant (`loginGoogle`, loopback + manual paste), the refresh
path, and `moh provider login|logout|status google` are untouched. What
leaves is the **offer** — the `api-key | subscription` question the
onboarding wizard (TUI and `moh provider add`) used to ask for google.

**It does not work.** The wizard's mandatory connection test failed
every time with `400 API_KEY_INVALID`, and a live probe of the owner's
own grant (2026-10-26) shows the failure is Google's answer, not a
request-shape slip:

- the probe sent the OAuth access token as `x-goog-api-key` to
  `generativelanguage.googleapis.com` (the api-key posture of
  `runConnectionTest`), which is never a valid API key;
- the same public endpoint refuses the token as `Authorization: Bearer`
  too, `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` — the grant carries
  `cloud-platform`, not the Generative Language scope;
- the backend the grant is actually for, Code Assist at
  `cloudcode-pa.googleapis.com/v1internal` (declared as
  `GOOGLE_API_BASE_URL`, never wired into the provider adapter), answers
  `v1internal:loadCodeAssist` with `currentTier: null`,
  `allowedTiers: [standard-tier]` (which requires a user-defined cloud
  project) and `ineligibleTiers: [{ reasonCode: "UNSUPPORTED_CLIENT",
  reasonMessage: "… Gemini Code Assist for individuals … migrate to the
  Antigravity suite of products: https://antigravity.google" }]`;
  `v1internal:generateContent` without a project answers
  `403 SUBSCRIPTION_REQUIRED` ("You do not have a valid license of this
  product").

So no consumer Google account can route inference through this grant as
of that date, independently of moh: the shipped OAuth client and scope
set match current gemini-cli, so re-login changes nothing. Implementing
the Code Assist transport (onboarding calls, `{model, project, request}`
bodies, SSE streaming) is therefore not worth building until a licensed
cloud project makes it verifiable.

The withdrawal needs no new mechanism: `google` joins the withheld set
behind the same `offersSubscriptionAuth` predicate, both clients' wizards
follow, and the remaining five grant kinds keep their choice. An endpoint
that already stores a google subscription token keeps its configuration —
nothing is converted, deleted, disabled, or called — and records the same
`endpoint_auth_withdrawn` warning per open, whose remedy sentence (add an
API-key endpoint, `moh provider logout <name>`) is kind-generic.
