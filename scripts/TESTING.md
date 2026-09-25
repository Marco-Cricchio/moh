# Local test runner

Use `bash scripts/test.sh packages/tui/test` for the TUI package. Unlike
`bun test packages/tui/test`, this runs top-level component tests first,
then PTY files in separate Bun processes, two at a time. The phases do not
overlap. Focused file arguments still run directly.

`bash scripts/test.sh` applies the same separation to the full suite.
`MOH_PTY_PARALLEL=0` opts out of splitting; `MOH_PTY_JOBS` controls PTY batch
size (default 2; 0 explicitly means unlimited).

The runner does not retry failed files. Read the saved logs, fix the cause,
then run only the failing files. A slower first run is not proof of greater
stability: compare first-attempt failures as well as total elapsed time.

Main logs use a unique temporary path unless `MOH_TEST_LOG` is supplied.
PTY logs and `results.tsv` (exit code, file, log path) live in a unique
printed directory unless `MOH_PTY_LOG_DIR` is supplied. The main log also
records PTY output and log locations. Use fresh override paths per run:
explicit paths are overwritten. Successful logs are retained too; remove
them when no longer needed. Process exit codes, not text markers, determine
success; failures to persist logs also fail the run.

A caller's outer timeout must cover both sequential phases. An interrupted
run is incomplete, never a green result; the manifest can contain only the
files already collected. No application test timeouts are changed by this
runner.
