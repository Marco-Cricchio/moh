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

Normalization is exactly 00-safety-net § 2 B2: ULID ids → ordinal tokens
(tree shape preserved), `hash`/`prevHash` chain values and `promptVersion`
(hashes over id-/path-bearing content) → ordinal tokens, ISO dates and
`*Ms` durations → placeholders, session/subagent ids, uuid suffixes, the
path-derived project slug, temp home/cwd/tmpdir prefixes, pid. Nothing
else — a reworded user-visible string MUST flip the compare.

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
reports the temp home/cwd it created so frames can normalize them.
