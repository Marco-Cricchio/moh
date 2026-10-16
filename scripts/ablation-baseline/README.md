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
preserving equality and linkage. Recorded full prompt text remains
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
  network for `update`/`provider login`);
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
servers stay reachable), and every scenario whose frames do not render the
Settings "Update check" row also sets `updateCheck: false`. The two that do
(`overlay-walk`, `settings-submodal-return`) keep the default `on`, which the
reference records, and rely on the dead proxy alone.
`tui-hermetic.test.ts` fails if a scenario has neither.

## Known B5 flake: `permission-prompt` / `permission-allowed` (#1482)

The `permission-allowed` frame in `tui/permission-prompt.json` is not
deterministic. Measured on `ef00d3c6` (code unmodified, sequential runs of
`bun scripts/ablation-baseline/tui.ts <fresh-dir> --only permission-prompt`,
each compared byte for byte with `current`):

- 10 of 60 recordings differed (about 1 in 6) in the first measurement;
- 18 of 30 differed (60%) in the PR review, with a load average of about 5-6.

The rate depends on machine load and is not a property of the scenario. In
all 18 differing files of the second measurement only
`frames["permission-allowed"]` differed; `frames["permission-prompt"]`,
`scenario`, `exited` and `exitCode` were identical.

Cause (measured, not fixed): the frame shape is fixed by the first repaint
after the modal closes (`ESC[?1049l`). In some runs that repaint redraws only
the composer and footer; in others it still redraws the tool and permission
rows (and sometimes the assistant block). The shape then never changes (20
runs sampled every 0.25 s for 6 s), so no longer settle or other readiness
condition on this screen can select one. Replaying the raw bytes through
`harness.py` `Screen` (whole, and in 7-byte chunks) reproduced the live shape
in 13 of 13 runs, so the emulator is not the source: the difference is in the
bytes the TUI emits (paint/promotion order, outside the harness).

Rule (uses only `current`): if a full B5 recording differs from `current`
**only** in `tui/permission-prompt.json`, re-record
`bun scripts/ablation-baseline/tui.ts <fresh-dir> --only permission-prompt`
in a new directory, up to 10 times, stopping at the first recording whose
`permission-prompt.json` is byte-identical to
`current/b5/tui/permission-prompt.json`.

- If one matches, it is the known instability (#1482).
- If none of the 10 matches, it is a regression to investigate.
- Any difference in another B5 file is a regression in every case.

A real change to that frame cannot produce a byte-identical match with
`current`, so the rule does not hide it. Why 10: with per-recording mismatch
probability p, a false "regression" after N attempts has probability p^N; at
p = 0.6 that is about 0.6% for N = 10 (about 22% for N = 3). Each attempt
takes about 14 s. Run one B5 recording at a time (fixed temp names), never
two in parallel.

The real fix is #1489 (a TUI change, outside the ablation and outside this
harness). If it lands, re-record the `permission-prompt` reference and rotate
`current` (#1378), then remove this section and its rule.

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
