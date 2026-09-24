# #953 — Coverage census: what the aggregators can actually supply for the 558 catalog rows

Research ticket of wayfinder map #952 ("moh owns its model catalog"). This census
measures how much of `packages/core/src/model-catalogs/*.json` (25 files, 558 model
rows) can be rebuilt from the two aggregators named in #951 — `models.dev/api.json`
and `openrouter.ai/api/v1/models` — and how much must stay hand-maintained.

Snapshots used (2026-09-24):
- https://models.dev/api.json (223 providers, 8173 model records)
- https://openrouter.ai/api/v1/models (458 records)
- pi-ai 0.87.1 (`@earendil-works/pi-ai`, npm tarball) as comparison reference only

Raw per-row data: [`951-coverage-census.json`](./951-coverage-census.json).
Generator: `scripts/census-953.ts` (throwaway, lives on this branch only).

## Method and join key

Per issue: **exact id first, then models.dev `base_model`, then the OpenRouter
namespaced id** (`vendor/model`). No id equivalence is assumed anywhere else.

- models.dev matching is **scoped to the candidate namespaces a moh file maps to**
  (the row's `provider` field / the file name / declared aliases such as
  `opencode-zen` → models.dev `opencode`, `kimi-coding` → `kimi-code-plan-global|cn`,
  `zai` → `zai|zai-coding-plan`, `minimax` → `minimax|minimax-cn|*coding-plan`,
  `moonshot` → `moonshotai|moonshotai-cn`). A bare-id match in an unrelated
  models.dev provider is **not** counted: that is how false multi-matches are avoided.
- `base_model` in models.dev: **0 records in the entire snapshot**. The join key
  named by the issue is effectively unused for models.dev today; the base-model
  verdict comes almost entirely from the OpenRouter namespaced id.
- **Verdicts**: `exact` = matched an aggregator id; `base-model` = matched only via
  the join keys above; `ambiguous` = more than one record **within the same source**
  matches with conflicting values (cross-source differences are recorded, not
  treated as conflicts — see units); `absent` = no record in either source.

## Headline numbers

| verdict | rows |
| --- | --- |
| exact | 509 |
| base-model | 11 |
| ambiguous | 5 |
| absent | 33 |
| **total** | **558** |

**525/558 (94%) is rebuildable from the two aggregators.** The hand-maintained
remainder is 33 rows.

## Hand-maintained remainder per provider

- `openrouter`: 23 rows (legacy previews, `:batch`/`:free` variants, retired ids —
  e.g. `deepseek/deepseek-v4-pro-0813:batch`, `minimax/minimax-m3:free`,
  `anthropic/claude-opus-4`, `~openai/gpt-latest`)
- one row each: `baseten` (`deepseek-ai/DeepSeek-R1`), `cerebras`
  (`llama-3.3-70b`), `cloudflare-ai-gateway`, `fireworks`, `minimax`
  (`MiniMax-Text-01`), `moonshot` (`moonshot-v1-128k`), `nvidia-nim`, `together`,
  `vercel-ai-gateway` (covered), `xiaomi-mimo` (`mimo-v2-flash`)

**Providers the aggregators do not cover at all**: none — every moh file has at
least one aggregator-matched row except the ten listed above with 1 absent row each
(those files are single-row files, so those specific rows are 100% hand-maintained).

## Ambiguous (5)

All in `zai.json` (`glm-4.7`, `glm-5-turbo`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`):
each matches in three places — models.dev `zai` (with prices), models.dev
`zai-coding-plan` (no prices), OpenRouter `z-ai/*` (USD/token) — with conflicting
cost/context values. This is the one genuine merge-conflict zone the merge-rule
ticket (#955/#956) must decide.

## base-model (11)

`openai-codex` (6: gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna/sol/terra — only via
OpenRouter `openai/*`; note models.dev also carries them under the `openai` provider
namespace, which this census deliberately did **not** alias to `openai-codex`),
`deepseek/deepseek-chat`, `qwen/qwen-plus`, `opencode-zen/qwen3.7-max`,
`opencode-zen/qwen3.7-plus`, `openrouter/*` (1).

## Cost backfill

Of 137 rows with no `cost` or an all-zero one, **99 are fillable** by the
aggregators; 38 stay empty from these sources. Which field each source supplies is
recorded per row in `suppliedBy`:

- models.dev: `cost` (USD/1M, numbers), `contextWindow`, `maxTokens`, `reasoning`,
  input modalities. **Never** `thinkingLevelMap`, `compat` flags, or per-model
  headers — those remain moh-owned.
- OpenRouter: `pricing` (USD/token, **strings**), `context_length`, input
  modalities, reasoning capability. No `maxTokens` output limit; no compat/thinking
  data.
- **Units flag (478 rows carry the note)**: every row with an OpenRouter match
  needs the ×1e6 token→1M conversion and string→number coercion; a naive copy would
  be wrong by six orders of magnitude.
- **Cross-source context differs**: 35 rows where models.dev and OpenRouter report
  different context windows (mostly github-copilot and opencode-* gateways vs the
  upstream vendor record) — recorded per row as `crossSourceContextDiffers`.

## pi-ai 0.87.1 comparison

pi-ai would supply only **3 of the 33 absent rows**
(`openai-codex/gpt-5.3-codex-spark`, `openrouter/mistralai/devstral-2512`,
`together/meta-llama/Llama-3.3-70B-Instruct-Turbo`). The moh catalog has already
drifted well past pi-ai 0.85.0 (the last regeneration source, per
`model-catalogs/README.md`): the aggregators strictly dominate it as a data source.

## Not decided here

Merge rules, source precedence, and what happens to ambiguous rows are **out of
scope** — that is ticket #955/#956, which this census unblocks.
