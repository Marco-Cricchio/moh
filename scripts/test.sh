#!/usr/bin/env bash
# Logged test entry point. Whole-suite and TUI-directory runs separate
# component tests from PTY processes, without overlapping their workloads.
# Focused file invocations remain direct. MOH_PTY_PARALLEL=0 opts out.
# Usage: scripts/test.sh [packages/tui/test | path/to/file.test.ts]
# MOH_TEST_LOG overrides the otherwise unique main log path.
set -uo pipefail

LOG=${MOH_TEST_LOG:-$(mktemp "${TMPDIR:-/tmp}/moh-bun-test.XXXXXX")}
status=0
split=0
tui_only=0
if [ "$#" -eq 1 ]; then
  case "${1%/}" in packages/tui/test|./packages/tui/test) tui_only=1 ;; esac
fi
if [ "${MOH_PTY_PARALLEL:-1}" = "1" ]; then
  if [ "$#" -eq 0 ] || [ "$tui_only" -eq 1 ]; then split=1; fi
fi

if [ "$split" -eq 1 ]; then
  MAIN_PATHS=()
  for dir in packages/*/test; do
    [ -d "$dir" ] || continue
    if [ "$dir" = "packages/tui/test" ]; then
      for f in "$dir"/*.test.*; do
        [ -f "$f" ] && MAIN_PATHS+=("$f")
      done
    elif [ "$tui_only" -eq 0 ]; then
      MAIN_PATHS+=("$dir")
    fi
  done
  if [ "$tui_only" -eq 0 ]; then MAIN_PATHS+=(scripts); fi
  echo '--- Component/non-PTY tests first; PTY batches follow without overlap'
  bun test "${MAIN_PATHS[@]}" 2>&1 | tee "$LOG"
  pipeline=("${PIPESTATUS[@]}")
  status=${pipeline[0]}
  if [ "${pipeline[1]}" -ne 0 ]; then status=1; fi
  bash scripts/test-pty-parallel.sh 2>&1 | tee -a "$LOG"
  pipeline=("${PIPESTATUS[@]}")
  pty=${pipeline[0]}
  if [ "${pipeline[1]}" -ne 0 ]; then pty=1; fi
  if [ "$status" -eq 0 ]; then status=$pty; fi
else
  bun test "$@" 2>&1 | tee "$LOG"
  pipeline=("${PIPESTATUS[@]}")
  status=${pipeline[0]}
  if [ "${pipeline[1]}" -ne 0 ]; then status=1; fi
fi

echo
echo "--- test log path: $LOG"
if [ "$status" -ne 0 ]; then
  echo '--- main-log failure digest (PTY failures have separate log paths above):'
  { grep -B14 '(fail)' "$LOG"; grep -E '^ [0-9]+ (pass|fail|skip)|^Ran [0-9]+ tests' "$LOG"; } \
    | grep -v '(pass)' | tail -120
fi
exit "$status"
