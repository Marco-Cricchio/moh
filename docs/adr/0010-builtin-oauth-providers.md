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
