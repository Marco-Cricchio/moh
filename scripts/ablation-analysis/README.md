# S0.4 — analysis tooling (#1387)

Dev-only evidence tooling for the ablation plan (#1387, procedure in the
#1378 tracking issue section 6). Nothing here is imported by
`packages/*/src`.

## Recorded runs

The analysis tooling (`refs.cjs`, `report.cjs`, `metrics.cjs`) and the
committed outputs (`out/refs.json`, `out/docs-mentions.txt`,
`out/b6/*`) were last regenerated at commit **d34a740a** (the commit
containing the final scripts). The regeneration is
deterministic: `node scripts/ablation-analysis/refs.cjs . <fresh>/out`
reproduces `out/refs.json` and `out/docs-mentions.txt` byte-identically
at any later head of this PR branch (verified at each regeneration; the
command has no timestamp, path or ordering nondeterminism).

Tool versions: TypeScript 5.9.3 (`packages/core/node_modules/typescript`),
Node v22.23.2, Bun 1.2.19 (aad3abea). Coverage run versions: see
`out/b6/MANIFEST.txt`.

## Coverage map (B6) — `scripts/ablation-coverage.sh`

Collects per-file line coverage (line coverage only: Bun 1.2.19 lcov emits no
FN/FNDA records) through the repository's phased
runner: the component phase (packages/*/test plus scripts/) in one bounded
`bun test --coverage` process, then each `packages/tui/test/pty/*.test.ts`
file in its own process (batched by `MOH_PTY_JOBS`, default 2) — the phases
never overlap and no whole-tree single-process run happens.

```sh
scripts/ablation-coverage.sh <outDir>   # e.g. ~/moh-ablation-baselines/1387-b6
```

Outputs in `<outDir>`:

- lcov profiles, one per process: `component-lcov.info` plus
  `pty-<file>-<n>.info` (the counter distinguishes multiple profiles a
  single PTY file may emit). Known blind spot: the PTY phase instruments
  only the test process, not the spawned `moh` process, so lines
  reachable only across the process boundary show as uncovered
  (conservative).
- `summary.txt` — per repo file: lines, lines hit (line coverage only;
  no function columns). Regenerate it from the profiles into a NEW
  directory, without writing into the profile dir:
  `python3 scripts/ablation-b6-summary.py <outDir> <fresh>/summary.txt`
  (the same script the collector calls; the optional second argument is
  the output path, default `<outDir>/summary.txt`). Rows outside `packages/` and `scripts/` are excluded.
- `component.log`, `pty-results.tsv` (exit codes + logs), `MANIFEST.txt`.

Reference snapshot for #1387: committed under `out/b6/` (summary +
MANIFEST). Raw lcov profiles are not committed; they live at
`~/moh-ablation-baselines/1387-b6/` and measure 498,192 bytes in total
(487,004 for `component-lcov.info`, 11,188 across the six PTY profiles;
`du -sk` of the seven `.info` files: 508 KiB) — measured with `ls -l`
and `du -k` at the last regeneration.

## Compiler-reference analysis — `refs.cjs` / `report.cjs` / `metrics.cjs`

Cross-reference over the whole monorepo with the TypeScript 5.9 compiler
API from `packages/core/node_modules/typescript` (the root typescript@7
has no JS API). Scans source, tests, scripts, the runnable `.ts`
examples and the ambient asset declarations; resolves aliases; records
per declaration: own-file uses, external source/test/example referrers,
reexport-only files, call-site argument counts, optional parameters.

```sh
node scripts/ablation-analysis/refs.cjs <repoRoot> <outDir>   # writes <outDir>/refs.json + docs-mentions.txt
node scripts/ablation-analysis/report.cjs <mode> [...names]   # reads <scriptdir>/out/refs.json
node scripts/ablation-analysis/metrics.cjs                    # prints every STARTING-METRICS.md row
```

`report.cjs` modes: `check <name>...`, `dead`, `testonly`, `exampleonly`,
`localonly`, `privatedead`, `optional`, `single`, `fanin`. It reads
`<scriptdir>/out/refs.json`, so run `refs.cjs` with `outDir` set to
`scripts/ablation-analysis/out`.

## Divergence from the #1378 § 6 bootstrap

`refs.cjs` started as the bootstrap script published in the #1378
tracking-issue section-6 comment and now **diverges** from it:

- **The runnable `.ts` examples are scanned.**
  `docs/extending/examples/*.ts` is added to the program and its
  referrers are recorded in a separate `extExample` field (referrer class
  "example"), distinct from source (`extSrc`) and test (`extTest`). The
  bootstrap never put `docs/` into the program, which misclassified
  `createSession` — the C7 keeper used by `run-extension.ts` — as
  test-only. Example referrers are excluded from `testonly` (mode
  `exampleonly` lists symbols reached only from examples) and from
  `srcFile`. Note: only `.ts` examples are scanned — the `.mjs` example
  (`no-rm-rf.mjs`) is not (the walk collects `*.ts|*.tsx` only).
- **Docs prose is searched textually.** `refs.cjs` also writes
  `<outDir>/docs-mentions.txt`: every declaration name as a bare word
  over `docs/**` markdown, with the declaring locations. A prose hit is
  E2 textual evidence to check by hand, never proof of liveness.
- `report.cjs check` additionally prints the `example` referrer list;
  `metrics.cjs` computes every metrics row from the repo tree.

Everything else (declaration collection, alias resolution, call-site
argument counts, report modes) is the bootstrap unchanged.

Referrer classification (`isTest`): a referrer file counts as **test**
when it matches `*.test.*`, lives under `packages/*/test/`, under any
`scripts/` directory (including `packages/*/scripts/**`, e.g. the
`smoke-*.ts` build tooling, and the repo-root `scripts/`), or under
`packages/evals/**`. Runnable examples (`docs/extending/examples/**`)
are their own class; everything else is source.

Known blind spots (documented in #1378 section 4/6, apply E1–E6 before any
deletion): duck-typed calls (`typeof x.m === "function"`, `as { m }`
casts — e.g. `ExtensionRuntime.bind*` appears "dead" but is called from
`AgentSession`'s constructor), interface-reached members (`Provider.stream`,
React lifecycles, `JsonRpcConnection.respondError`), string-keyed/bracket
access, reexport-only entry points (flagged `[reexported: …]`).

Per-symbol reports at the last regeneration (see STARTING-METRICS.md for
the commit): dead 33, test-only 57, example-only 0, file-local-only 1028,
private-dead 29, never-passed optional parameters 53 — all reproduced by
`node scripts/ablation-analysis/metrics.cjs`.
