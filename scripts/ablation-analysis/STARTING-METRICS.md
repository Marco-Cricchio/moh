# S0.4 starting metrics — measured "before" column (#1387)

Measured on the #1387 branch (`git rev-parse HEAD` in MANIFEST below;
only ablation dev-tooling commits on top of `91a264b4`, the Phase-0
approved develop reference). All numbers come from the committed
tooling: `scripts/ablation-analysis/refs.cjs` (TS 5.9 compiler API,
whole monorepo), `scripts/ablation-analysis/report.cjs`, and
`scripts/ablation-coverage.sh` (phased `bun test --coverage`).
Historical figures from the tracking issue are in parentheses —
remeasured, never chased.

| Metric | Before (measured) | Historical (5c938a03) |
|---|---:|---:|
| core index export names | 632 | 653 exports |
| core index lines | 1182 | 1183 |
| TUI index export names | 72 | ~70 |
| file-local exported symbols, zero refs anywhere, excluding `@moh/extension` | 32 | 659 file-local exported symbols (different, broader definition: exported-but-only-locally-used) |
| exported top-level, zero refs anywhere incl. tests (`report dead`) | 33 | 33 (confirmed inventory) |
| exports reachable only from tests (`report testonly`) | 58 | — |
| exported, only used inside own file (`report localonly`) | 1028 | — |
| non-exported, never referenced (`report privatedead`) | 29 | — |
| functions with never-passed optional params (`report optional`) | 53 | ~50 |
| core source files | 143 | 153 |
| source files excluding tests, all packages + scripts | 305 | — |
| source lines excluding tests | 90139 | ~88k |
| provider-kind (`anthropic`/`openai`/`google`/`github-copilot`/`openrouter`/`kimi-coding`/`xai`) string-literal lists in core src, files touching each kind | 8–13 files per kind | six provider-kind lists (definition predates this measurement; see #1423) |
| atomic write sites (`renameSync` after temp write) | 20 files, 48 occurrences | 15 (different definition: `writeFileSync(tmp)` + `renameSync(tmp, file)` pairs; #1425) |
| duck-typing sites (`typeof x.y === "function"` / `as { … }` casts, core+cli+tui src) | 35 | F5 finding (#1438) |
| per-file line coverage (B6, phased runner) | 312 repo files, 42103/46744 lines hit (90.1%) | — |

Definitions for reproducibility:

- **core index export names**: named export specifiers parsed from
  `packages/core/src/index.ts` (TS AST), 632; TUI likewise, 72.
- **file-local exported, zero refs**: `exported && top-level`, no
  external source or test referrer and no own-file use, excluding
  `packages/extension/**` (G5 keeps its surface out of scope).
- **provider-kind lists**: counted as the number of non-test core source
  files whose text contains each kind string (8–13 per kind); the
  historical "six lists" counted whole kind-name arrays, which this pass
  did not isolate — remeasured at #1423's scope, not now.
- **atomic write**: every non-test occurrence of `renameSync` under
  `packages/*/src` (48 occurrences in 20 files); the historical count of
  15 counted only the strict `writeFileSync(tmp)` + `renameSync(tmp,file)`
  pair shape.

## Reproduce

```sh
node scripts/ablation-analysis/refs.cjs . scripts/ablation-analysis/out
cd scripts/ablation-analysis
node report.cjs dead|testonly|localonly|privatedead|optional|single|fanin
scripts/ablation-coverage.sh <outDir>   # ~6 min, phased, PTY per-file
```

Blind spots carried forward (apply #1378 section 4 E1–E6 before deleting
anything): duck-typed member calls (`bindToolSeam` and friends are called
through `as { … }` casts from `AgentSession`'s constructor and appear
"dead" to the compiler), interface-reached members (`Provider.stream`,
React lifecycles, `JsonRpcConnection.respondError`), string-keyed and
bracket access, entry-point re-export-only symbols (flagged
`[reexported: …]` in the reports).
