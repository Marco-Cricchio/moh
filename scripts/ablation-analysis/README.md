# S0.4/B6 — coverage map and compiler-reference analysis (#1387)

Dev-only evidence tooling for the ablation plan (#1387, procedure in the
#1378 tracking issue section 6). Nothing here is imported by
`packages/*/src`.

Recorded runs (exact commit + tool versions):

- Analysis (refs.json, docs-mentions, reports): commit = the HEAD this
  file is read at (regenerate to remeasure); TypeScript 5.9.3
  (`packages/core/node_modules/typescript`), Node v22.23.2, Bun 1.2.19.
  Command: `node scripts/ablation-analysis/refs.cjs . scripts/ablation-analysis/out`
  from the repo root.
- Coverage (B6): see `out/b6/MANIFEST.txt` (commit, Bun, Python, terminal
  note, per-process command).

## Coverage map (B6) — `scripts/ablation-coverage.sh`

Collects per-file line/function coverage through the repository's phased
runner: the component phase (packages/*/test plus scripts/) in one bounded
`bun test --coverage` process, then each `packages/tui/test/pty/*.test.ts`
file in its own process (batched by `MOH_PTY_JOBS`, default 2) — the phases
never overlap and no whole-tree single-process run happens.

```sh
scripts/ablation-coverage.sh <outDir>   # e.g. ~/moh-ablation-baselines/1387-b6
```

Outputs in `<outDir>`:

- `component-lcov.info` + one `pty-<file>-<n>.info` per PTY profile
  (lcov; the `<n>` counter distinguishes multiple profiles a single PTY
  file may emit). Known blind spot: the PTY phase instruments only the
  test process, not the spawned `moh` process, so lines reachable only
  across the process boundary show as uncovered (conservative).
- `summary.txt` — per repo file: funcs, funcs hit, lines, lines hit
  (accumulated over all processes; out-of-repo temp fixtures excluded;
  the map includes test files and `scripts/` support files — filter rows
  by path when a source-only view is needed);
- `component.log`, `pty-results.tsv` (exit codes + logs), `MANIFEST.txt`
  (commit, Bun/Python versions, exact per-process command).

Reference snapshot for #1387: committed under `out/b6/` (summary +
MANIFEST); the raw lcov profiles stay at `~/moh-ablation-baselines/1387-b6/`
(~100 KB total, outside the repo).

## Compiler-reference analysis — `refs.cjs` / `report.cjs`

Cross-reference over the whole monorepo with the TypeScript 5.9 compiler
API from `packages/core/node_modules/typescript` (the root typescript@7
has no JS API). Scans source, tests, scripts and the ambient asset
declarations; resolves aliases; records per declaration: own-file uses,
external source/test referrers, reexport-only files, call-site argument
counts, optional parameters.

```sh
node scripts/ablation-analysis/refs.cjs <repoRoot> <outDir>   # writes <outDir>/refs.json + <outDir>/docs-mentions.txt
node scripts/ablation-analysis/report.cjs <mode> [...names]   # reads <scriptdir>/out/refs.json
```

`report.cjs` modes: `check <name>...`, `dead`, `testonly`, `exampleonly`,
`localonly`, `privatedead`, `optional`, `single`, `fanin`. It reads
`<scriptdir>/out/refs.json`, so run `refs.cjs` with `outDir` set to
`scripts/ablation-analysis/out`.

## Divergence from the #1378 § 6 bootstrap

`refs.cjs` started as the bootstrap script published in the #1378
tracking-issue section-6 comment and now **diverges** from it:

- **Runnable examples are scanned.** `docs/extending/examples/*.ts` is
  added to the program and its referrers are recorded in a separate
  `extExample` field (referrer class "example"), distinct from source
  (`extSrc`) and test (`extTest`). The bootstrap never put `docs/` into
  the program, which misclassified `createSession` — the C7 keeper used
  by `run-extension.ts` — as test-only. Example referrers are excluded
  from `testonly` (new mode `exampleonly` lists symbols reached only from
  examples) and from `srcFile`.
- **Docs prose is searched textually.** `refs.cjs` also writes
  `<outDir>/docs-mentions.txt`: every declaration name as a bare word
  over `docs/**` markdown, with the declaring locations. A prose hit is
  E2 textual evidence to check by hand, never proof of liveness.
- `report.cjs check` additionally prints the `example` referrer list.

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

Per-symbol reports measured on this branch (analysis rerun after the
example/docs scan; refs: 5953 declarations):
dead 33, test-only 57, example-only 0, file-local-only 1028,
private-dead 29, never-passed optional parameters 53.

