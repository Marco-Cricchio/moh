# S0.4 starting metrics — measured "before" column (#1387)

**Last regenerated at: d34a740a** — the commit containing the final
`refs.cjs` + `metrics.cjs` and the committed outputs (`out/refs.json`,
`out/docs-mentions.txt`, `out/b6/*`). Every value below is produced by
`node scripts/ablation-analysis/metrics.cjs` run from the repo root
(after `node scripts/ablation-analysis/refs.cjs .
scripts/ablation-analysis/out`); the B6 rows additionally by
`python3 scripts/ablation-b6-summary.py ~/moh-ablation-baselines/1387-b6 <fresh>/summary.txt`.
The regeneration is deterministic and reproduces byte-identically at any
later head of this PR branch.

Tool versions: TypeScript 5.9.3 (`packages/core/node_modules/typescript`),
Node v22.23.2, Bun 1.2.19 (aad3abea). Coverage-run record:
`out/b6/MANIFEST.txt`.

Historical figures from the tracking issue are in parentheses —
remeasured, never chased.

| Metric | Before (measured) | Definition (as printed by metrics.cjs) | Command |
|---|---:|---|---|
| core index export names | 632 (653 exports) | named export specifiers in `packages/core/src/index.ts` (TS AST) | `node scripts/ablation-analysis/metrics.cjs` |
| core index lines | 1182 (1183) | `wc -l` of `packages/core/src/index.ts` | `wc -l packages/core/src/index.ts` |
| TUI index export names | 72 (~70) | named export specifiers in `packages/tui/src/index.ts` (TS AST) | `node scripts/ablation-analysis/metrics.cjs` |
| exported top-level, zero refs anywhere incl. tests | 33 (33 confirmed) | `refs.json: exported && extSrc=0 && extTest=0 && extExample=0 && ownUses=0`, source files only | `node scripts/ablation-analysis/report.cjs dead` |
| exports reachable only from tests | 57 (58 pre-example-scan) | `refs.json: exported`, no src/example referrer, ≥1 test referrer, no own use | `node scripts/ablation-analysis/report.cjs testonly` |
| symbols reached only from runnable examples | 0 | `refs.json: exported`, no src/test referrer, ≥1 example referrer, no own use | `node scripts/ablation-analysis/report.cjs exampleonly` |
| exported, only used inside own file | 1028 (1028) | `refs.json: exported`, no external src referrer, ownUses>0 (tests allowed) | `node scripts/ablation-analysis/report.cjs localonly` |
| non-exported, never referenced | 29 (29) | `refs.json: !exported`, no referrer anywhere, kind≠Property, name≠constructor | `node scripts/ablation-analysis/report.cjs privatedead` |
| functions with never-passed optional params | 53 (53, ~50 historical) | `refs.json: params optional && p.i >= max(callArgCounts) && calls>0` | `node scripts/ablation-analysis/report.cjs optional` |
| refs.json declarations | 5953 (5942 pre-example-scan) | collected declarations (top-level + class methods + example files) | last line of `node scripts/ablation-analysis/refs.cjs . scripts/ablation-analysis/out` |
| file-local exported, zero refs anywhere, excluding `@moh/extension` | 32 (32) | `refs.json: exported && top`, `extSrc=0 && extTest=0 && extExample=0 && ownUses=0`, file under `packages/` but not `packages/extension/` | `node scripts/ablation-analysis/metrics.cjs` |
| core source files | 143 (153) | distinct `file` values under `packages/core/src/` in refs.json | `node scripts/ablation-analysis/metrics.cjs` |
| source files excluding tests | 305 | `git ls-files -- "packages/*.ts" "packages/*.tsx" "scripts/*.ts"`, excluding `*.test.*`, `*/test/*`, `*.d.ts` | `node scripts/ablation-analysis/metrics.cjs` |
| source lines excluding tests | 90139 (~88k) | `split("\n")` line count (= `wc -l` + 1 per file with a final unterminated line) over the same file set; plain `wc -l` gives 89834 | `node scripts/ablation-analysis/metrics.cjs` |
| provider-kind lists (7 OAuth kinds) | 7-13 (files per kind; six lists) | `packages/core/src` non-test files containing the kind as an exact TS string literal (TS AST), per kind: anthropic 8, openai 7, google 10, github-copilot 13, openrouter 10, kimi-coding 13, xai 8 | `node scripts/ablation-analysis/metrics.cjs` |
| atomic write sites | **20 files, 50 occurrences** (15) | every non-test occurrence of `renameSync` under `packages/*/src` | `grep -rn "renameSync" packages/*/src \| grep -v /test/` |
| per-file line coverage (B6, phased runner) — all rows | 312 files, 42103/46744 lines hit (90.1%) | `out/b6/summary.txt` rows: repo files, line coverage only (Bun 1.2.19 lcov emits no FN/FNDA records). Breakdown: 14 test-support files, 3 scripts files — 14 under `packages/*/test/`, 3 under `scripts/` (`ablation-baseline/normalize.ts`, `build.ts`, `close-delivered-issues.ts`) | `python3 scripts/ablation-b6-summary.py ~/moh-ablation-baselines/1387-b6 <fresh>/summary.txt` |
| per-file line coverage (B6) — source-only view | **295 files, 41196/45721 lines hit (90.1%)** | `out/b6/summary.txt` rows under `packages/*/src` only (all `scripts/` rows and test-support rows excluded) | `awk -F'\t' 'NR>1 && $1!~/\/test\// && $1!~/^scripts\//{n++;l+=$2;h+=$3} END{print n,h"/"l}' scripts/ablation-analysis/out/b6/summary.txt` |

## Withdrawn metric: duck-typing sites

The first draft published "35 duck-typing sites (core+cli+tui src)" from
an ad-hoc grep that mixed two different patterns; no precise definition
reproduces it, so the row is **withdrawn** rather than left without a
command. F5's `ExtensionRuntime.bind*` duck-typing finding stands on its
own (#1438 owns it); the mechanism is covered by the refs.json blind-spot
note in the README.

## Reproduce

```sh
node scripts/ablation-analysis/refs.cjs . scripts/ablation-analysis/out
node scripts/ablation-analysis/metrics.cjs
cd scripts/ablation-analysis && node report.cjs dead|testonly|exampleonly|localonly|privatedead|optional|single|fanin
python3 scripts/ablation-b6-summary.py ~/moh-ablation-baselines/1387-b6 <fresh>/summary.txt   # new dir: never writes into the profile dir
```

Blind spots carried forward (apply #1378 section 4 E1–E6 before deleting
anything): duck-typed member calls (`bindToolSeam` and friends are called
through `as { … }` casts from `AgentSession`'s constructor and appear
"dead" to the compiler), interface-reached members (`Provider.stream`,
React lifecycles, `JsonRpcConnection.respondError`), string-keyed and
bracket access, entry-point re-export-only symbols (flagged
`[reexported: …]` in the reports), and the B6 process-boundary blind spot
documented in `out/b6/MANIFEST.txt`.
