# moh

## Language

All repo artifacts (issues, PRs, comments, docs, code, commit messages) are in **English**. All conversation with the owner across moh sessions is in **Italian**. Never ask about this again.

## Branching

The integration branch is **`develop`**. Always create PRs targeting `develop` (base branch: `develop`), never `main`. `main` is only updated by promoting from `develop` (explicitly requested by the owner). Never merge a PR into `main`.

## Principles

Consult `docs/principles.md` before any change. The seven principles govern the architecture; a change that violates one needs an explicit ADR saying why.

## Testing flow

`bash scripts/test.sh` runs the component/non-PTY tests first and then the PTY files (`*.pty.test.ts`) as separate bun processes (bounded batches, default 2) — the phases never overlap, and `MOH_PTY_JOBS` sets the batch size (`MOH_PTY_PARALLEL=0` opts out; `MOH_PTY_LOG_DIR` keeps the per-file logs and exit-code manifest). No file is retried: a failed file is red, and its log is kept. ADR-0057 moved the TUI behavioural gate off the pty (the in-process fake terminal is the gate; `tui-pty` holds only the process-boundary claims), so the PTY tail is no longer the slow phase it was — a whole-tree run takes ~8 minutes locally, and it is the component tests that dominate. Test-harness or runner changes still want one full run before the PR, and the PR CI run (parallel jobs, see `.github/workflows/ci.yml`) is the safety net for everything not run locally. The component tests that used to flake under load (`logo-ramp`, `settings-panel`, `incremental-static`, `app-overlays`, `home`, `subagent-panel-app`, `exit-keys` #1009, `settings-repaint-race` #330) were fixed in #1466–#1476: they waited on fixed sleeps. A loaded run that still fails a component test: confirm it in isolation before treating it as your regression — do not rerun the whole tree. An inefficient loop — rerunning suites just to re-read an error — wastes both wall time and tokens. Follow these rules:

1. **During implementation, run only the files you touched** (`bun test packages/<pkg>/test/<file>.test.ts`), not the suite.
2. **At the end of a change, run the full suite only once, and only when the change touches shared code** (core, session assembly, test harness, anything imported across packages). For a change confined to one package or a leaf feature, running that package's test dir is enough — the PR's CI run (parallel jobs; the TUI unit-test job retries once) covers the rest of the tree.
3. **If a run fails, never rerun it to see the error.** Grep/read the log instead: the runner prints the main log path and the PTY log directory (`MOH_TEST_LOG` / `MOH_PTY_LOG_DIR` override both). The first run already contains every failure with source, expected/received, and stack.
4. **After a fix, re-run only the failing test files** — never the full suite, even after a fix to shared code (CI covers the cross-package blast radius).
5. **No confirmation re-runs without a change in between.**
6. **Never run a whole test directory as one `bun test` process when it contains PTY/faketty tests** (`packages/tui/test` above all). That is the failure mode this session hit: a single-process run of the whole TUI tree left one PTY test spinning at 100% CPU for 30+ minutes after its timeout, 6 files never ran, and the PTY files bulk-failed under load (the known flake pattern). Use `bash scripts/test.sh` for anything wider than a handful of files — it phases component vs PTY tests and bounds the batch. A quick heuristic for one file: if it spawns a real pty/faketty App, treat it as PTY-class.
7. **Prefer isolation-first over full-tree verification**: run the touched files in isolation; when a run fails under a wide run, before diagnosing re-run the failing file *alone* — an isolated pass means load, not regression (then stop; do not chase it in the same change — but a test that fails only under load is still a waiting bug: report it with an issue). Verify "is it my change?" with `git stash` + the single failing file, not a second full-tree run.
8. **Watch for a hung runner**: a `bun test` process at 100% CPU with no new output for several minutes after a timeout is hung — kill it and switch to per-file runs (`timeout 120 bun test <files>`); never wait it out.
9. **TUI component tests wait on state, never on fixed sleeps** (#1466–#1476). Ink's `useInput` re-subscribes its handler in a passive effect, so a key written right after a surface paints can still reach the previous surface's handler; a fixed `sleep(30)` only hides that on a quiet machine. Use the helpers in `packages/tui/test/helpers.ts`: `waitText`/`waitStep` (deadline + named stuck step + effect flush) before each key, `sendPrompt` for the composer, `pressCommitted` for a key that paints nothing, `pressSettled` (`act()`) when the next key reads state an effect re-publishes. A sleep is fine only before a negative assertion over an interval.
10. **Attribute pre-existing failures before owning them**: when unrelated test files fail alongside your change, stash and re-run those files on the clean tree; pre-existing/environmental failures (leaked user-home state, e.g. the manual-modal jev chip) are reported as such, never fixed in passing.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (Marco-Cricchio/moh) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default triage label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

### User manual

The pages bundled into the binary (ADR-0013, ADR-0072) live in
`packages/core/src/manual/`; `docs/manual/` is their generated mirror — never edit
those files directly (`bun packages/core/scripts/gen-manual-docs.ts`
regenerates them). Light-alignment rule: a PR that changes a user-visible door
(keybinding, slash command, CLI flag, config key, wizard/screen copy) updates
the affected `docs/manual/` page in the same PR.
