# S0.4/B6 — coverage map and compiler-reference analysis (#1387)

Dev-only evidence tooling for the ablation plan (#1387, procedure in the
#1378 tracking issue section 6). Nothing here is imported by
`packages/*/src`.

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

- `component-lcov.info` + one `pty-<file>.info` per PTY file (lcov);
- `summary.txt` — per repo file: funcs, funcs hit, lines, lines hit
  (accumulated over all processes; out-of-repo temp fixtures excluded);
- `component.log`, `pty-results.tsv` (exit codes + logs), `MANIFEST.txt`
  (commit, Bun/Python versions, exact per-process command).

Reference snapshot for #1387: `~/moh-ablation-baselines/1387-b6/`
(recorded on the #1387 branch, ablation harness only).

## Compiler-reference analysis — `refs.cjs` / `report.cjs`

Cross-reference over the whole monorepo with the TypeScript 5.9 compiler
API from `packages/core/node_modules/typescript` (the root typescript@7
has no JS API). Scans source, tests, scripts and the ambient asset
declarations; resolves aliases; records per declaration: own-file uses,
external source/test referrers, reexport-only files, call-site argument
counts, optional parameters.

```sh
node scripts/ablation-analysis/refs.cjs <repoRoot> <outDir>   # writes <outDir>/refs.json
node scripts/ablation-analysis/report.cjs <mode> [...names]   # reads <scriptdir>/out/refs.json
```

`report.cjs` modes: `check <name>...`, `dead`, `testonly`, `localonly`,
`privatedead`, `optional`, `single`, `fanin`. It reads
`<scriptdir>/out/refs.json`, so run `refs.cjs` with `outDir` set to
`scripts/ablation-analysis/out`.

Known blind spots (documented in #1378 section 4/6, apply E1–E6 before any
deletion): duck-typed calls (`typeof x.m === "function"`, `as { m }`
casts — e.g. `ExtensionRuntime.bind*` appears "dead" but is called from
`AgentSession`'s constructor), interface-reached members (`Provider.stream`,
React lifecycles, `JsonRpcConnection.respondError`), string-keyed/bracket
access, reexport-only entry points (flagged `[reexported: …]`).

Per-symbol reports measured on the #1387 branch (refs: 5942 declarations):
dead 33, test-only 58, file-local-only 1028, private-dead 29, never-passed
optional parameters 53.
