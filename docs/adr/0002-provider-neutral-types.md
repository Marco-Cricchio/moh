# 0002 — Provider-neutral types; AI SDK as invisible engine

Date: 2026-08-21 · Status: accepted · Refs: moh map #1, tickets #5, #7, #8

## Context

moh is provider-agnostic from day one. The SDK research (#5) recommends the Vercel
AI SDK v5 as the default provider layer. The provider abstraction ticket (#8) had
to decide whether moh's public surface (`@moh/core`) exposes AI SDK types or its own.

## Decision

moh defines its own provider-neutral types (`Provider`, `ChatRequest`, `StreamEvent`,
`ToolSpec`, `ProviderError`) exported from `@moh/core`. The AI SDK is an
implementation detail of the default adapter bundle: no AI SDK type appears in any
public API. Custom providers implement the moh `Provider` interface (single method,
`stream()`) and never depend on Vercel packages.

## Consequences

- Custom provider authors install/know nothing about the AI SDK.
- A mapping layer between moh types and AI SDK types must be maintained; new SDK
  features may lag behind the moh interface.
- The AI SDK bundle could be replaced in a future version without breaking custom
  providers or extensions.
- The agent loop is single-shot per provider call: the AI SDK's internal multi-step
  loops are disabled, because loop control (per-turn cap, steering, event log)
  belongs to the core (#7).
