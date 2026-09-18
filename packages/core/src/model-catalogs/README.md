# Vendored model catalogs

These JSON files are copied from or generated from the model catalogs of the auto-generated model
catalogs of [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
(MIT license, © Earendil Works), vendored per the decision recorded on
issue #156: no runtime dependency on pi-ai (principle 3 — SDKs invisible),
and an auditable, versioned data surface.

- `anthropic.json` — Anthropic models (Claude Pro/Max subscriptions)
- `openai-codex.json` — ChatGPT/Codex backend models (Plus/Pro subscriptions)
- `google.json` — Google AI Studio / Gemini models (personal Google accounts)
- `github-copilot.json` — GitHub Copilot models (claude/gpt/gemini/kimi/grok;
  per-model wire + editor headers, #164)
- `openrouter.json` — OpenRouter's multi-vendor list (vendored verbatim,
  346 models — one regeneration story for all providers, #164)
- `kimi-coding.json` — Kimi Code models (k3 family; anthropic-messages wire
  + compat flags)
- `xai.json` — xAI grok models
- `zai.json` — Z.ai GLM models (generated from pi-ai's `ZAI_MODELS` provider module; Z.ai speaks openai-compat in moh)
- `opencode-zen.json` / `opencode-go.json` — official OpenCode Zen and Go `/models`
  snapshots (2026-09-18). They intentionally contain model IDs only: OpenCode
  does not publish the metadata needed to assert capabilities or pricing.

Source version at the last regeneration: **pi-ai 0.85.0**.

## Regeneration

```sh
bun run packages/core/scripts/regen-model-catalogs.ts <path-to-a-pi-ai-install>
# e.g.:
bun run packages/core/scripts/regen-model-catalogs.ts \
  node_modules/@earendil-works/pi-ai
```

The script copies the `providers/data/*.json` catalogs from pi-ai's `dist/`
(or source root) and generates `zai.json` from pi-ai's `ZAI_MODELS` provider
module, then prints the pi-ai version so this README can be updated.


## Pricing

The same release-pinned catalog records approximate USD per-million-token
rates used by `moh usage` and the TUI quota modal. They are estimates, not
billing data: update them only through regeneration and update the source
version above in the same change. Live model discovery never changes prices;
models without a catalog rate remain tokens-only. See ADR-0029.
