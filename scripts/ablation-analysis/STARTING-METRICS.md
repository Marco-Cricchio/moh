# S0.4 starting metrics — measured "before" column (#1387)

Measured on branch `ablation/1387-s0.4`:

- analysis rows: commit **6a48f4e9** (refs.json committed there), tooling
  TypeScript **5.9.3** (`packages/core/node_modules/typescript`), Node
  **v22.23.2**, Bun **1.2.19** (aad3abea);
- coverage row: run at commit **f083de0f**, summary regenerated at
  **91afcb12** — full record in `scripts/ablation-analysis/out/b6/MANIFEST.txt`
  (committed next to the summary; an earlier draft of this file wrongly
  said "MANIFEST below").

Historical figures from the tracking issue are in parentheses —
remeasured, never chased. Every row states its definition and the exact
command that produces it; commands run from the repo root.

| Metric | Before (measured) | Definition | Command |
|---|---:|---|---|
| core index export names | 632 (653 exports) | named export specifiers in `packages/core/src/index.ts` (TS AST) | `node -e` snippet recorded in the review thread: parse the file with `ts.createSourceFile`, sum `isNamedExports` elements over `ExportDeclaration`s |
| core index lines | 1182 (1183) | `wc -l` of `packages/core/src/index.ts` | `wc -l packages/core/src/index.ts` |
| TUI index export names | 72 (~70) | named export specifiers in `packages/tui/src/index.ts` (TS AST) | same snippet on the TUI file |
| exported top-level, zero refs anywhere incl. tests | 33 (33 confirmed) | `report dead`: `exported && extSrc=0 && extTest=0 && extExample=0 && ownUses=0`, source files only | `node scripts/ablation-analysis/report.cjs dead` |
| exports reachable only from tests | 57 (58 pre-example-scan) | `report testonly`: `exported`, no src/example referrer, ≥1 test referrer, no own use | `node scripts/ablation-analysis/report.cjs testonly` |
| symbols reached only from runnable examples | 0 | `report exampleonly`: `exported`, no src/test referrer, ≥1 example referrer, no own use | `node scripts/ablation-analysis/report.cjs exampleonly` |
| exported, only used inside own file | 1028 (1028) | `report localonly`: `exported`, no external src referrer, ownUses>0 (tests allowed) | `node scripts/ablation-analysis/report.cjs localonly` |
| non-exported, never referenced | 29 (29) | `report privatedead`: `!exported`, no referrer anywhere, kind≠Property, name≠constructor | `node scripts/ablation-analysis/report.cjs privatedead` |
| functions with never-passed optional params | 53 (53, ~50 historical) | `report optional`: params optional && `p.i >= max(callArgCounts)` && calls>0 | `node scripts/ablation-analysis/report.cjs optional` |
| refs.json declarations | 5953 (5942 pre-example-scan) | collected decls (top-level + class methods) | last line of `refs.cjs` output |
| file-local exported, zero refs anywhere, excluding `@moh/extension` | 32 (32) | `exported && top`, `extSrc=0 && extTest=0 && extExample=0 && ownUses=0`, `file` not under `packages/extension/` | `node -e` filter over `out/refs.json` with the same predicate as `dead`/`testonly` restricted to `packages/` minus extension (snippet in the review thread) |
| core source files | 143 (153) | distinct `file` values under `packages/core/src/` in refs.json | `node -e 'const r=require("./scripts/ablation-analysis/out/refs.json");console.log(new Set(r.filter(x=>x.srcFile&&x.file.startsWith("packages/core/src/")).map(x=>x.file)).size)'` |
| source files excluding tests (all packages + scripts) | 305 | git-tracked `*.ts`/`*.tsx` under `packages/ scripts/`, excluding `*.test.*`, `*/test/**`, `*.d.ts` | `git ls-files 'packages/*.ts' 'packages/*.tsx' 'scripts/*.ts' \| grep -v '\.test\.' \| grep -v '/test/' \| grep -v '\.d\.ts$' \| wc -l` |
| source lines excluding tests | 90139 (~88k) | `split("\n")` line count (i.e. `wc -l` + 1 per file, counting a final unterminated line) over the same file set; `wc -l` alone gives 89834 | `node -e` snippet recorded in the review thread: `git ls-files -- "packages/*.ts" "packages/*.tsx" "scripts/*.ts"` → filter `!/\.(test)\.|\/test\/|\.d\.ts$/` → sum `readFileSync(f,"utf8").split("\n").length` per file |
| provider-kind lists (7 OAuth kinds) | 7–13 files per kind (six lists) | non-test `packages/core/src` files containing the kind as an exact TS string literal (`"anthropic"`, `"openai"`, …), counted per kind via the compiler API | AST one-liner recorded in the review thread: for each core src file, `ts.createSourceFile` + visit all nodes counting `isStringLiteral(n) && n.text === kind`; values anthropic 8, openai 7, google 10, github-copilot 13, openrouter 10, kimi-coding 13, xai 8 |
| atomic write sites | 20 files, 48 occurrences (15) | every non-test occurrence of `renameSync` under `packages/*/src` | `grep -rn "renameSync" packages/*/src \| grep -v /test/` (file count: pipe through `awk -F: '{print $1}' \| sort -u \| wc -l`) |
| duck-typing sites | **withdrawn** — see below | — | — |
| per-file line coverage (B6, phased runner) | 312 repo files, 42103/46744 (90.1%) | summary rows of the committed B6 map (includes test-support files; source-only view 297 files, 41281/45888, 90.0%) | `scripts/ablation-coverage.sh <outDir>`; committed copy: `out/b6/summary.txt` |

## Withdrawn metric: duck-typing sites

The first draft published "35 duck-typing sites (core+cli+tui src)" from
an ad-hoc grep that mixed two different patterns. On re-measurement the
reliable counts are pattern-specific and much larger than 35 (`as {` casts
alone are ~110). Because the row had no precise definition or single
command, it is **withdrawn** rather than left unreproducible; F5's
`ExtensionRuntime.bind*` duck-typing finding stands on its own (#1438
owns it) and the refs.json blind-spot note covers the mechanism.

## Reproduce

```sh
node scripts/ablation-analysis/refs.cjs . scripts/ablation-analysis/out
cd scripts/ablation-analysis
node report.cjs dead|testonly|exampleonly|localonly|privatedead|optional|single|fanin
scripts/ablation-coverage.sh <outDir>   # ~6 min, phased, PTY per-file
```

Blind spots carried forward (apply #1378 section 4 E1–E6 before deleting
anything): duck-typed member calls (`bindToolSeam` and friends are called
through `as { … }` casts from `AgentSession`'s constructor and appear
"dead" to the compiler), interface-reached members (`Provider.stream`,
React lifecycles, `JsonRpcConnection.respondError`), string-keyed and
bracket access, entry-point re-export-only symbols (flagged
`[reexported: …]` in the reports), and the B6 process-boundary blind spot
documented in `out/b6/MANIFEST.txt`.
