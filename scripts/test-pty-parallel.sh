#!/usr/bin/env bash
# Bounded PTY batches, compatible with macOS bash 3.2.
# Keep every log and use process exit codes, including crashes without a
# Bun `(fail)` marker. No implicit retries: the first verdict is evidence.
# MOH_PTY_JOBS=0 explicitly requests all-at-once execution.
set -uo pipefail
cd "$(dirname "$0")/.."

JOBS=${MOH_PTY_JOBS:-2}
case "$JOBS" in
  ''|*[!0-9]*) echo 'MOH_PTY_JOBS must be a non-negative integer' >&2; exit 2 ;;
esac
LOG_DIR=${MOH_PTY_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/moh-pty-logs.XXXXXX")}
mkdir -p "$LOG_DIR" || exit 2
fail=0
total=0
pids=()
files=()

settle() {
  local i code f log
  for ((i=0; i<${#pids[@]}; i++)); do
    code=0
    wait "${pids[$i]}" || code=$?
    f=${files[$i]}
    log="$LOG_DIR/$(basename "$f").log"
    printf '%s\t%s\t%s\n' "$code" "$f" "$log" >> "$LOG_DIR/results.tsv" || fail=1
    if [ "$code" -ne 0 ]; then
      fail=1
      echo "--- PTY failed (exit $code): $f"
      echo "--- log: $log"
      tail -60 "$log"
    fi
  done
  pids=()
  files=()
}

: > "$LOG_DIR/results.tsv" || exit 2
for f in packages/tui/test/pty/*.test.ts*; do
  [ -f "$f" ] || continue
  bun test "$f" < /dev/null > "$LOG_DIR/$(basename "$f").log" 2>&1 &
  pids+=("$!")
  files+=("$f")
  total=$((total+1))
  if [ "$JOBS" -gt 0 ] && [ "${#pids[@]}" -ge "$JOBS" ]; then settle; fi
done
settle
if [ "$total" -eq 0 ]; then
  echo 'No PTY test files found' >&2
  fail=1
fi
echo "--- PTY logs and exit codes: $LOG_DIR"
if [ "$fail" -eq 0 ]; then echo "pty-parallel: all $total PTY files green (no retries)"; fi
exit "$fail"
