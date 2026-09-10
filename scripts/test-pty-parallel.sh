#!/usr/bin/env bash
# Parallel PTY runner. Each PTY test file is a fully independent bun
# process (own python harness, own fake provider server, own pseudo
# terminal), and the tests are wait-dominated (~0.07s CPU per second of
# wall), so parallelism is safe on small machines. 3-way was validated
# on 8 cores: ~330s of serial PTY time in ~130s wall; the default batch
# size runs all files at once (the bun processes are ~wait-only) — set
# MOH_PTY_JOBS to batch if a machine is constrained.
#
# POSIX-safe: macOS ships bash 3.2 (no `wait -n`, no associative arrays,
# and zombies keep `kill -0` true — so per-pid `wait` with a pid list is
# the only portable pool).
set -u
cd "$(dirname "$0")/.."

JOBS=${MOH_PTY_JOBS:-0} # 0 = no batching: all files at once
fail=0
list="${TMPDIR:-/tmp}/moh-pty-logs.$$.list"
: > "$list"
trap 'rm -f "$list"' EXIT

launch() {
  local f=$1
  local log="${TMPDIR:-/tmp}/moh-pty-$$-$(basename "$f").log"
  echo "$log" >> "$list"
  (bun test "$f" < /dev/null > "$log" 2>&1) &
  LAST_PID=$!
}

if [ "$JOBS" -le 0 ]; then
  for f in packages/tui/test/pty/*.test.ts*; do launch "$f"; done
  wait || fail=1
else
  batch=0
  pids=""
  for f in packages/tui/test/pty/*.test.ts*; do
    launch "$f"
    pids="$pids $LAST_PID"
    batch=$((batch+1))
    if [ "$batch" -ge "$JOBS" ]; then
      for p in $pids; do wait "$p" || fail=1; done
      pids=""
      batch=0
    fi
  done
  for p in $pids; do wait "$p" || fail=1; done
fi

# Verdict digest: surface every failure, drop pass noise, clean the logs.
total=0
while read -r log; do
  [ -f "$log" ] || continue
  total=$((total+1))
  if grep -q "(fail)" "$log"; then
    fail=1
    echo "--- PTY failures:"
    grep -B12 "(fail)" "$log" | grep -v "(pass)"
  fi
  rm -f "$log"
done < "$list"

if [ "$fail" -eq 0 ]; then
  echo "pty-parallel: all $total PTY files green"
fi
exit "$fail"
