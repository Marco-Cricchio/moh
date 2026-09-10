#!/usr/bin/env bash
# bun test with a persistent log (test-flow convention, see AGENTS.md).
#
# On failure, grep the log for the error — NEVER rerun the suite just to
# see it again. The digest below prints every failure block (source,
# expected/received, stack) so the first run is usually all you need.
#
# Usage:
#   scripts/test.sh                      # full suite
#   scripts/test.sh packages/tui/test/x.test.ts   # focused run
#
# Log path override: MOH_TEST_LOG=/tmp/my.log scripts/test.sh
# PTY parallelism: MOH_PTY_PARALLEL=1 runs the 12 PTY files as parallel
# bun processes (scripts/test-pty-parallel.sh, 3-way default) instead of
# inside the main invocation — roughly halves the serial PTY block.
set -uo pipefail

LOG=${MOH_TEST_LOG:-/tmp/moh-bun-test.log}
status=0

if [ "${MOH_PTY_PARALLEL:-0}" = "1" ] && [ "$#" -eq 0 ]; then
  # Main invocation: everything except the pty dir (explicit positive
  # paths — bun's `!` negation is a name filter, not a file exclusion).
  MAIN_PATHS=()
  for dir in packages/*/test; do
    [ -d "$dir" ] || continue
    if [ "$dir" = "packages/tui/test" ]; then
      # top-level tui tests only; pty/ goes to the parallel runner
      for f in "$dir"/*.test.*; do MAIN_PATHS+=("$f"); done
    else
      MAIN_PATHS+=("$dir")
    fi
  done
  echo "--- PTY files run in parallel via scripts/test-pty-parallel.sh"
  bun test "${MAIN_PATHS[@]}" 2>&1 | tee "$LOG"
  main=${PIPESTATUS[0]}
  bash scripts/test-pty-parallel.sh
  pty=$?
  [ "$main" -ne 0 ] && status=$main
  [ "$pty" -ne 0 ] && status=$pty
else
  bun test "$@" 2>&1 | tee "$LOG"
  status=${PIPESTATUS[0]}
fi

echo
echo "--- test log saved: $LOG"
if [ "$status" -ne 0 ]; then
  echo "--- failure digest:"
  # Each failure block ends with a "(fail)" line; show the ~14 lines of
  # context before it (source excerpt + expected/received + stack) and the
  # summary block at the end. Drop pass noise.
  { grep -B14 '(fail)' "$LOG"; grep -E '^ [0-9]+ (pass|fail|skip)|^Ran [0-9]+ tests'; } \
    | grep -v '(pass)' | tail -120
fi
exit "$status"
