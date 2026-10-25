# Ablation baseline harness (Phase 0)

Dev tooling for the ablation plan's safety net (00-safety-net § 2). Nothing
here is imported by `packages/*/src`; the whole directory may be deleted
when the plan completes.

## B2 — golden sessions (`b2.ts`)

```sh
bun scripts/ablation-baseline/b2.ts record <outDir> [--only <scenario>...]
bun scripts/ablation-baseline/b2.ts compare <dirA> <dirB>   # exit 1 on any diff
```

`record` runs every scenario (isolated temp home/cwd, one child process
each — bun snapshots `os.homedir()` at startup, and subagent child logs
default to it) and writes per scenario:

- `events.jsonl` — the session JSONL, normalized;
- `requests.json` — every recorded `stream()` call (deep-copied messages,
  tool specs, options) of every recorder the scenario wired in;
- `results.json` — the `TurnResult`s the scenario pushed, by label;
- `fs.json` — home + cwd after `dispose()`: relative path, file mode,
  normalized content.

Normalization preserves configured limits and message text. Only measured
`durationMs`, `ttfcMs`, `waitMs`, `wallTimeMs`, and `toolDurationMs` values
are masked; `timeoutMs`, `hookTimeoutMs`, `retryAfterMs`, `resetMs`, and
other configured budgets remain byte-compared, including their prose.
Elapsed prose is masked only in CLI/TUI report rows matching
`tokens · wall … · tools …` (including `model-serving tools`), never in
provider requests or event messages. In a bordered box row (a `│` after
the masked text) the run of spaces before that border is resized so the
row keeps its pre-mask width, so the frame does not depend on the length
of the measured duration text (`850ms` vs `1.2s`); if the masked content
no longer fits that width the run becomes one space. Rows with no masked
rendering are never touched. Pids require an explicit process
context and a whole integer token. Date-only masking uses the UTC date
captured at process startup; fixed fixture dates survive. Full ISO
run timestamps are masked before date-only matching.

ULID ids, chain hashes and prompt-version hashes use ordinal tokens
preserving equality and linkage. Each token kind is numbered on its own
(`<session:0>` is the first session id of the artifact, whatever other
kinds were registered before it; #1520). Recorded full prompt text remains
compared. Session/subagent ids, UUIDs, temp project slugs and temp paths
are normalized as before. A reworded user-visible string or configured
limit MUST flip the compare.

Every subsequent ablation step must compare its fresh B1–B5 recording
against the durable starting reference, never against a post-change
recording. The reference lives outside the repository and outside `/tmp`
in `~/moh-ablation-baselines/508b16ef/`; its `MANIFEST` records
the exact commit, tool versions, terminal dimensions and commands.

## Files

- `recording-provider.ts` — scripted turns + call log (`MockProvider.scripted`
  format, per 00 § 2 B2);
- `scenarios.ts` — the ten scenario groups;
- `normalize.ts` — the normalizer;
- `b2.ts` — B2 runner (`compare` subcommand);
- `surface.ts` — B1 public-surface snapshot (TypeScript 5.9 compiler API);
- `cli.ts` — B3 CLI transcripts (fixture home, every subcommand, blocked
  network for `update`/`provider login`). Each command has a 120 s ceiling
  (`MOH_B3_TIMEOUT_MS` raises it); a command that exceeds it is killed and
  the recording fails naming it — it is never written as `exit: 137` (#1617);
- `serve.ts` — B4 `moh serve` conversations (RPC v1);
- `tui.ts` — B5 TUI frame scripts (PTY harness): overlay walk, Settings
  sub-modal return, permission prompt, `!` command, `@file` mention;
- `compare.ts` — standalone tree comparator for any baseline output
  (imports nothing from the packages: a broken build must not break the
  comparator).

```sh
bun scripts/ablation-baseline/surface.ts <outDir>
bun scripts/ablation-baseline/cli.ts <outDir>
bun scripts/ablation-baseline/serve.ts <outDir>
bun scripts/ablation-baseline/tui.ts <outDir>
bun scripts/ablation-baseline/compare.ts <dirA> <dirB>
```

B5 needs python3 (the PTY harness) and runs one PTY at a time. It waits
the random startup intro out (~3.15 s) and settles before every
checkpoint, so frames are stable across runs; `pty-runner.ts` gained two
additive options for it (`bareProject`, `timeoutMs`) and `harness.py`
reports the temp home/cwd it created so frames can normalize them. Two
more additive options close the `stranded` gap: `seedStranded` (seeds
the #1217 on-disk state — declared identity, live dir with
`stranded-data.json`, source dir with data) and `fixedTempNames` (fixed
temp home/cwd names: the warning row and modal print absolute paths that
wrap mid-token, and a random mkdtemp suffix would leak at every wrap
point).

Known residual gaps: `skill-chooser` (needs a claimed tracker issue),
`skill-updates` (needs pending upstream updates), `cold-wizard` (needs a
gist scan) — all three need network/auth state the harness cannot seed
deterministically; scripted retro extraction (no seam in moh.json);
network *blocking* is proven only via the dead proxy, not positively.
B2's `g1-reasoning-wire` covers reasoning over a real (local SSE)
openai-compat wire; a remote wire is intentionally out of scope.

## Baselines never touch the network (#1517)

No baseline may depend on the network or on the content of the remote
`main`. On launch the TUI compares the bundled skills with the index on
GitHub `main` (`updateCheck` opt-out, `packages/tui/src/App.tsx`); with a
changed bundled skill the status row would show `· 1 skill update
available` and B5 would differ with no TUI change.

B5 therefore runs every scenario with a dead proxy in the child's
environment (`tui-hermetic.ts`, loopback excepted so the fake provider
servers stay reachable), and every scenario except two also sets
`updateCheck: false`. The two exceptions (`overlay-walk`,
`settings-submodal-return`) render the Settings "Update check" row, which the
reference records as `on`, so they keep the default and rely on the dead proxy
alone. `tui-hermetic.test.ts` checks the spec that `tui.ts` runs (`specFor`)
against literal values: the proxy keys, the loopback bypass and the opt-out.

## B5 recorded exit code (#1524)

The PTY harness ends every scenario with SIGINT, then SIGTERM, then SIGKILL
if the child is still alive 2 s later, so a signal-killed child's status
(`-15` or `-9`) depends only on how fast it shut down. `tui.ts` records both as
`-15` (`recordedExitCode`). A clean `0`, a still-running `null` and any other
status are recorded as they are, so a real change in how the TUI exits still
shows. A B5 difference that is only `-15` → `-9` can no longer occur; the old
"re-record that scenario" rule for it is retired.

## B7 — Manual smoke checklist

Run after each phase with a real terminal and credentials:

- Start moh, resume from Home, rotate permission modes.
- Open Settings and theme studio; run `/model`, `/compact`, `/tree`,
  `/extensions`, `/retro`; open quota (ctrl+q) and notes (ctrl+n).
- Exercise the skill chooser with a claimed tracker issue.
- Exercise skill updates with a pending upstream update.
- Exercise the cold-directory wizard with a real gist scan.
- Trigger retro extraction and inspect the resulting findings.
- Exit with ctrl+c twice; run `moh run` against a real endpoint; start
  an OAuth `moh provider login` up to the browser step.

Skill chooser, skill updates, cold wizard and retro extraction are manual
obligations: B5 does not establish their behavior.

## Phase 0 correction verification

Starting production source is unchanged from `5c938a03`. Paired recordings
were identical: B1 1 file, B2 152 files, B3 71 files, B4 7 files, B5 9 files.
The bash default timeout (30000 → 31000), default hook ceiling (30000 →
31000), and headless permission error rewording each produced exit 1 and
two differing artifacts; each restore produced exit 0 and four identical
files. The durable reference retains the raw sensitivity diff reports.

Group 6 fixtures include manifests and real capability declarations,
correct host/append/state APIs, successful model switching, synthetic turns
and both model/tool hook timeouts. The runner awaits extension readiness.
B5's overlay walk uses fixed temp names for wrapped browser paths and waits
for the model picker's catalog refresh before capture.

The one whole-tree verification run recorded 4416 pass, 3 fail, 5 todo;
all six PTY files passed without retries. Home stranded and team stop-all
passed in isolation after baseline attribution and restoring the changes.
The logo font assertion also failed on HEAD without these changes: it is
pre-existing and remains unfixed. The suite is not claimed fully green.
