# ADR-0030: OpenCode as a first-class provider

- Status: accepted
- Date: 2026-09-18
- Issue: #794

## Context

OpenCode Zen and Go share API-key authentication but have separate product
endpoints, catalogues, entitlement, and cost semantics. A generic
`openai-compat` profile cannot preserve those boundaries.

## Decision

`opencode` is a built-in provider kind. The explicit profiles
`opencode-zen` and `opencode-go` resolve respectively to
`https://opencode.ai/zen/v1` and `https://opencode.ai/zen/go/v1`, both
authenticating with a bearer API key. OpenCode has **no kind-level wire**:
the wire is per model and per product (the same id can differ between Zen
and Go). Every route target therefore resolves its wire from the endpoint's
own packaged overlay — `openai-responses`, `anthropic-messages`,
`openai-chat`, or `google` per the official endpoint tables — following the
github-copilot per-model seam.

Their model IDs are live-listed independently and cached through the existing
catalogue seam. Versioned Zen and Go overlays contain only official metadata;
unknown models remain conservative. No quota API is probed and Go prices are
not inferred.

## Consequences

Routes retain the existing `endpoint/model-id` grammar while catalogues and
credentials stay provider-bound. There is no OpenCode-specific transport or
public Core API.
