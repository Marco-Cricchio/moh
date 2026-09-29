# ADR-0057: the TUI's behavioural gate leaves the pty

Status: accepted · Date: 2026-09-28 · Issue: #1052 · Spec: `docs/spec/tui-test-architecture.md`
Related: #1045 (the previous attempt), #950, #622, #1022, #203, #972

## Context

`tui-pty` is the slowest and least reliable gate in the repository: 14 files, 30 tests,
2 860 lines (680 of them a Python VT100 model), **11m26s** on CI against `tui-unit`'s 2m37s.
Its verdicts are a function of the host and of a presentation clock rather than of the code:
the same test passes in isolation (4/4), fails intermittently inside its own file, and fails on
CI — and *which* test fails changes from run to run, sometimes as an assertion, sometimes as a
readiness expiry (#1052).

Two facts reframe it. First, **the behaviour is already covered elsewhere**: 74 in-process
renderer files (`ink-testing-library`, 700+ tests) include `transcript` (50), `home` (37),
`settings-panel` (37), `scrollback-layout`, `live-reasoning-static` (14), `incremental-static`
(15), `reasoning-order`, `mode-repaint`, `settings-repaint-race`. The pty suite re-implements
that contract through the most expensive and least deterministic channel available. Second,
**the suite's weights are inverted**: 14 of its 30 tests are the `streaming-persistence`
family and 4 guard `clearTerminal` while an oversized surface sits idle (an Ink layout
property, deterministic in-process), while only 5 need a real terminal at all.

The evidence that hardening the existing channel cannot close this is #1045: it made the
readiness wait honest, raised its budget, and removed waits that could never hold — and the red
moved one step downstream, from the wait to the assertion after it.

## Decision

**Split the suite by cost of observation, and move the behavioural gate off the pty.** Three
levels, spelled out (with the test-by-test mapping) in `docs/spec/tui-test-architecture.md`:

- **Level 0 — pure math.** The transcript model (promotion, the volatile trim, sealing and
  splicing, the settled boundary, the tail cap, markdown/transcript, the reveal cursor as a
  function) asserts the exact row at the exact instant, with no clock at all.
- **Level 1 — in-process terminal, and the gate for TUI behaviour.** A fake tty (recording
  stdout, chosen `columns`/`rows`) plus the harness's `Screen` model ported to TypeScript, so
  the physical screen, the scrollback, frame heights, `ED2`/`ED3` wipes, fullscreen adoption
  and "prints once" are asserted deterministically, in seconds.
- **Level 2 — pty integration gate.** A handful of tests (target: five) for what only a real
  process on a real terminal contributes: startup, raw-mode keys, the alternate screen and
  its restore on exit, `SIGWINCH`, byte-level `--no-color`, and the image protocols.

**A parity test guards the simulator.** One scripted scenario runs through level 1 and level 2
and compares the physical screen and the scrollback; a divergence is a failure, not a note.
This is the accepted trade-off of the decision: we replace a real terminal, in the gate, with
a model we own — and we pay for it with a test rather than with an assumption.

**The rules that make the move safe**, each verifiable in review:

1. **A baseline measured before anything moves.** `docs/spec/tui-test-baseline.md` records every
   assertion the current 30 tests make; a move is accepted by *behaviour equality* — the new
   test must go red under a mutation that violates the old assertion — never by greening.
2. **No deletion before its replacement exists and is shown red for that mutation.**
3. **The pacing becomes injectable and the promotion stops depending on it.** Level 1 drives
   the clock; the `MOH_TYPEWRITER_*` environment knobs go away.
4. **No `wait: N` without a needle.** A fixed sleep in TUI test code is a bug; the suite
   carries 170 of them today.
5. **The gate is hermetic** (`TZ=UTC`; the suite already uses `bun:test`'s `setSystemTime`) and
   **the runtime is pinned** — CI installs `bun-version: latest` while a local checkout runs
   1.2.19 and the runner reported 1.4.2.
6. **No silent skips and no retry-until-green.** A guard that cannot hold is a failure, as
   #1045 established; the retry that exists today failed twice in a row on the same assertion.

Sequence: **D** (the product-side pacing/promotion change, the level-0 targets, the baseline),
then **B** (the level-1 gate: the 25 moved tests, the parity test, the guards), then **C** (the
level-2 gate: one job, pinned runtime, needs-only waits). Each step lands green alone; #1052
closes when step C does.

## Consequences

- `tui-pty` drops from ~11m26s to ~2-3m, and the TUI's behavioural gate stops being a
  function of the runner. PRs that cannot influence the TUI (docs-only ones included) stop
  inheriting a red that has nothing to do with them.
- The pty suite stops *defining* TUI behaviour and becomes the proof that the behaviour
  reaches a real terminal. New TUI behaviour is expected to be tested at level 0/1, with level 2
  reserved for claims a real pty is needed for.
- Coverage becomes an audited artifact (the baseline) instead of an assumption, which is what
  makes "quality must not drop" a checkable condition rather than a promise.
- The cost is real and is paid up front: porting ~25 tests, writing the fake tty and the
  TypeScript screen model, and keeping one parity scenario honest.
- Deferred, not decided here: the `tui-unit` suite's own structure, and any behaviour change to
  the reveal beyond making it a function of injected pacing.

## Considered Options

- **Harden the existing suite only** (state waits, `untilInScrollback`, budgets declared against
  the fixture's cadence) — this is the #1045 shape, and it has already been run: the deadline
  moves rather than disappears, and the 11-minute, host-dependent gate stays.
- **A deterministic clock by faking timers inside the pty tests** — rejected: it means reaching
  into Ink 6's scheduling, and on Bun 1.2.19 vs 1.4.2 the option is not even the same option.
  A *controllable* clock run by us (level 1) is the same win without the fragility.
- **Quarantine the flaky tests** — rejected: the retry already exists and failed twice in a row;
  quarantining hides the class instead of removing it, and the suite's claims are load-bearing.
- **Golden/snapshot testing of whole frames** — rejected as the primary channel: snapshots
  detect change, not correctness, and they would freeze layout noise the suite currently
  distinguishes from corruption.
- **Keep the pty suite as it is and accept a red gate** — rejected: a required context that
  goes red at random teaches people to ignore it, which costs more than it saves.
