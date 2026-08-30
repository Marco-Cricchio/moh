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
set -uo pipefail

LOG=${MOH_TEST_LOG:-/tmp/moh-bun-test.log}
bun test "$@" 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}

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
