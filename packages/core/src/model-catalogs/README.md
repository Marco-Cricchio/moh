# Vendored model catalogs

These three JSON files are verbatim copies of the auto-generated model
catalogs of [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
(MIT license, © Earendil Works), vendored per the decision recorded on
issue #156: no runtime dependency on pi-ai (principle 3 — SDKs invisible),
and an auditable, versioned data surface.

- `anthropic.json` — Anthropic models (Claude Pro/Max subscriptions)
- `openai-codex.json` — ChatGPT/Codex backend models (Plus/Pro subscriptions)
- `google.json` — Google AI Studio / Gemini models (personal Google accounts)

Source version at the last regeneration: **pi-ai 0.84.2**.

## Regeneration

```sh
bun run packages/core/scripts/regen-model-catalogs.ts <path-to-a-pi-ai-install>
# e.g.:
bun run packages/core/scripts/regen-model-catalogs.ts \
  node_modules/@earendil-works/pi-ai
```

The script copies `providers/data/{anthropic,openai-codex,google}.json`
from pi-ai's `dist/` (or source root) into this directory verbatim, then
prints the pi-ai version so this README can be updated.
