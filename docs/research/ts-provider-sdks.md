# Research: TS options for provider-agnostic LLM access

**Question:** Landscape of TypeScript options for provider-agnostic LLM access: Vercel AI SDK vs direct SDKs (Anthropic/OpenAI/Google/Ollama). Coverage of token streaming, tool/function calling, parallel tool calls, prompt caching.

**Date:** 2025-02 — knowledge cutoff caveat: verify version-specific claims against linked docs.
**Sources:** primary documentation only (ai-sdk.dev, platform docs, official SDK repos/docs, Ollama API docs).

## TL;DR

- **Vercel AI SDK** (v5) is the strongest provider-agnostic abstraction in TS: one API (`streamText`, `generateText`, `tools`) across 100+ providers, with unified streaming, tool calling, and multi-step agent loops. Some bleeding-edge provider features (e.g. explicit prompt-cache breakpoints) are opt-in via provider-specific options rather than fully unified.
- **Direct SDKs** give day-one access to every provider feature and full fidelity, at the cost of per-provider code and no shared abstraction.
- **Ollama** exposes plain HTTP/JSON; `ollama` (official) and `ollama-ai` npm packages are thin wrappers. For tool calling/streaming you use its OpenAI-compat endpoint or the native API — feature coverage is narrower than the big three.

## Option 1: Vercel AI SDK (`ai` + `@ai-sdk/*`)

- **Abstraction:** `LanguageModelV2` provider spec; swap providers by changing one package + model string. Core: `generateText`, `streamText`, `generateObject`, `tool()`, `stepCount`-based agent loops (`stopWhen: stepCountIs(n)` in v5).
  - Source: https://ai-sdk.dev/docs (Overview, Providers).
- **Token streaming:** Yes — `streamText(...).textStream` (plain text delta stream), plus `fullStream` for structured parts (tool-call chunks, reasoning, sources). Unified across providers.
  - Source: https://ai-sdk.dev/docs/ai-sdk-core/streaming
- **Tool calling:** Yes — `tools` param, Zod schemas, `toolChoice` control. Unified, incl. multi-step execution and `prepareStep`.
  - Source: https://ai-sdk-core docs → Tool Calling (https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- **Parallel tool calls:** Supported where the provider supports it; `toolChoice`/parallel-calls behavior mirrors the underlying provider API via `providerOptions`. Anthropic provider exposes its own `parallelToolCalls` semantics in the mapping layer.
  - Source: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling and provider pages (https://ai-sdk.dev/providers)
- **Prompt caching:**
  - **Anthropic:** `cacheControl` via `providerOptions.anthropic.cacheControl` on system prompt/messages — maps directly to Anthropic's `cache_control` breakpoints.
    - Source: https://ai-sdk.dev/providers/ai-sdk-providers (Anthropic provider section)
  - **OpenAI:** automatic server-side caching; SDK needs no opt-in (usage includes `cachedInputTokens`).
  - **Gemini:** `providerOptions.google.cache` (explicit caching) — provider-specific.
  - Not unified across all providers; it's an `providerOptions` extension point.

## Option 2: Direct SDKs

### `@anthropic-ai/sdk` (Anthropic)
- **Streaming:** yes — `client.messages.stream()` returns an event-emitting helper with typed events (`content_block_delta`, etc.); raw SSE also available.
  - Source: https://github.com/anthropics/anthropic-sdk-typescript (README, streaming section); https://docs.anthropic.com/en/api/messages-streaming
- **Tool calling:** yes — `tools` param with JSON Schema; `tool_use` content blocks; `tool_result` in follow-up turns.
  - Source: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use
- **Parallel tool calls:** supported — single response can contain multiple `tool_use` blocks (up to `disable_parallel_tool_use` / `parallel_tool_calls: false` to disallow).
  - Source: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use
- **Prompt caching:** best-in-class — explicit `cache_control: {type: "ephemeral"}` breakpoints (up to 4), 5-min default TTL, 1h opt-in; cache reads ~10x cheaper. Usage reporting includes cache read/write tokens.
  - Source: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

### `openai` (OpenAI official)
- **Streaming:** yes — `client.chat.completions.create({stream: true})` and `client.responses.stream()` (Responses API); typed chunk/event iterators.
  - Source: https://github.com/openai/openai-node; https://platform.openai.com/docs/api-reference/streaming
- **Tool calling:** yes — function tools (strict JSON Schema mode available) in both Chat Completions and Responses; Responses API also has built-in tools (web search, etc.).
  - Source: https://platform.openai.com/docs/guides/function-calling
- **Parallel tool calls:** yes — `parallel_tool_calls: true` (default on) in Chat Completions; Responses does it implicitly.
  - Source: https://platform.openai.com/docs/guides/function-calling
- **Prompt caching:** automatic for prompts >1024 tokens (50% discount on cached input); no opt-in flag. Cached token counts in usage.
  - Source: https://platform.openai.com/docs/guides/prompt-caching

### `@google/genai` (Google Gemini — replaces deprecated `@google/generative-ai`)
- **Streaming:** yes — `ai.models.generateContentStream(...)` yields chunks; also SSE/REST `:streamGenerateContent`.
  - Source: https://github.com/googleapis/js-genai; https://ai.google.dev/api/generate-content
- **Tool calling:** yes — `tools` with function declarations (OpenAPI-style subset schema); automatic vs. manual (`functionCalling` mode) execution.
  - Source: https://ai.google.dev/gemini-api/docs/function-calling
- **Parallel tool calls:** yes — Gemini can return multiple `functionCall` parts in one turn (parallel calling documented in the function-calling guide).
  - Source: https://ai.google.dev/gemini-api/docs/function-calling
- **Prompt caching:** explicit `cachedContent` resources (min 32k tokens for some models / 4k for others), TTL configurable (default 1h). Also implicit per-provider caching on Gemini 2.5.
  - Source: https://ai.google.dev/gemini-api/docs/caching

### `ollama` (official Node/TS)
- **Streaming:** yes — `/api/chat` with `"stream": true` (NDJSON); packages `ollama` (browser/Node, fetch-based) and `ollama-ai`. Also an OpenAI-compatible endpoint (`/v1/chat/completions`) usable with the `openai` SDK pointed at a local base URL.
  - Source: https://github.com/ollama/ollama-js; https://github.com/ollama/ollama/blob/main/docs/api.md
- **Tool calling:** yes, model-dependent — `tools` param in `/api/chat`; supported models list (llama3.1+, qwen2.5, mistral-nemo, …). `tool_calls` in response.
  - Source: https://github.com/ollama/ollama/blob/main/docs/api.md (Chat request → tools)
- **Parallel tool calls:** limited — the API can return multiple `tool_calls` per message for capable models, but there is no parallel-tool-call control parameter; behavior is model-driven and less predictable than the hosted providers.
  - Source: https://github.com/ollama/ollama/blob/main/docs/api.md
- **Prompt caching:** no explicit API — server keeps recently used models/models in memory (model load caching), but no prompt-prefix cache control or cached-token pricing (it's local; cost is irrelevant, latency partially mitigated).
  - Source: https://github.com/ollama/ollama/blob/main/docs/faq.md

## Comparison matrix

| Capability | AI SDK (v5) | anthropic | openai | @google/genai | ollama |
|---|---|---|---|---|---|
| Token streaming | ✅ unified (`textStream`/`fullStream`) | ✅ | ✅ | ✅ | ✅ (NDJSON / OpenAI-compat) |
| Tool/function calling | ✅ unified + Zod | ✅ | ✅ | ✅ | ⚠️ model-dependent |
| Parallel tool calls | ✅ (via provider support / providerOptions) | ✅ (default, can disable) | ✅ (`parallel_tool_calls`) | ✅ (multi functionCall parts) | ⚠️ model-driven, no control |
| Prompt caching | ⚠️ per-provider via `providerOptions` | ✅ explicit breakpoints | ✅ automatic (>1024 tok) | ✅ explicit `cachedContent` | ❌ none |
| Provider swap cost | change model string | rewrite | rewrite | rewrite | rewrite |
| Newest features | delayed via provider layer | day one | day one | day one | day one |

## Recommendation for `moh`

Given the ticket's four features, the pragmatic default is **Vercel AI SDK** for provider-agnostic core (streaming, tools, parallel calls), with **`providerOptions.anthropic.cacheControl`** for prompt caching on Claude (the strongest caching story of the big three). Drop to a direct SDK only when a provider feature isn't yet mapped in the AI SDK provider package. For local/Ollama support, use AI SDK's `ollama` community provider or the OpenAI-compat endpoint.

Keep in mind: AI SDK majors move fast (v4 → v5 broke APIs); pin versions and check the migration guide before upgrading.
