#!/usr/bin/env bash
# B6 coverage collection through the repository's phased runner: the
# component phase and every PTY process run in their own `bun test
# --coverage` process, never overlapping (00-safety-net § 2, B6; #1387).
#
#   scripts/ablation-coverage.sh <outDir>
#
# Writes per-phase lcov profiles under <outDir>/ (one file per process:
# `component-lcov.info`, `pty-<file>-<n>.info` — the counter distinguishes
# multiple profiles a single PTY file may emit) plus `summary.txt`
# (per-file totals, via scripts/ablation-b6-summary.py) and `MANIFEST.txt`
# (commit, tool versions, exact commands).
# The profiles stay in lcov form; merge/derive reports from them with any
# lcov tooling — this script never runs one whole-tree bun test process.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=${1:?usage: scripts/ablation-coverage.sh <outDir>}
mkdir -p "$OUT"
: > "$OUT/summary.txt"

commit=$(git rev-parse HEAD)
bunver=$(bun --version)
pyver=$(python3 --version 2>&1)
{
  echo "B6 coverage collection"
  echo "Commit: $commit"
  echo "Bun: $bunver"
  echo "Python: $pyver"
  echo "Commands: this script; per process: bun test --coverage --coverage-reporter=lcov --coverage-dir=<dir> <paths>"
} > "$OUT/MANIFEST.txt"

covflags=(--coverage --coverage-reporter=lcov)

# --- Phase 1: component / non-PTY tests, one bounded process ---------------
component_cov="$OUT/component"
mkdir -p "$component_cov"
echo "--- component phase (packages/*/test, scripts/) into $component_cov"
MAIN_PATHS=()
for dir in packages/*/test; do
  [ -d "$dir" ] || continue
  if [ "$dir" = "packages/tui/test" ]; then
    for f in "$dir"/*.test.*; do
      case "$f" in *.pty.test.ts|*.pty.test.tsx) continue ;; esac
      [ -f "$f" ] && MAIN_PATHS+=("$f")
    done
  else
    MAIN_PATHS+=("$dir")
  fi
done
MAIN_PATHS+=(scripts)
if bun test "${covflags[@]}" --coverage-dir="$component_cov" "${MAIN_PATHS[@]}" 2>&1 | tee "$OUT/component.log"; then
  :
else
  echo "--- component phase: bun test exited non-zero (profile kept; see $OUT/component.log)" >&2
fi
for f in "$component_cov"/*.info; do
  [ -f "$f" ] || continue
  mv "$f" "$OUT/component-$(basename "$f")"
done
rm -rf "$component_cov"

# --- Phase 2: PTY files, one process per file (scripts/test-pty-parallel.sh,
# batched by MOH_PTY_JOBS) ---------------------------------------------------
pty_cov_root="$OUT/pty-collections"
mkdir -p "$pty_cov_root"
JOBS=${MOH_PTY_JOBS:-2}
LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/moh-pty-cov.XXXXXX")
: > "$LOG_DIR/results.tsv"
pids=(); files=(); dirs=()

settle() {
  local i code f log
  for ((i=0; i<${#pids[@]}; i++)); do
    code=0
    wait "${pids[$i]}" || code=$?
    f=${files[$i]}
    log="$LOG_DIR/$(basename "$f").log"
    printf '%s\t%s\t%s\n' "$code" "$f" "$log" >> "$LOG_DIR/results.tsv"
    if [ "$code" -ne 0 ]; then
      echo "--- PTY under coverage failed (exit $code): $f"
      echo "--- log: $log"
    fi
  done
  pids=(); files=(); dirs=()
}

echo "--- PTY phase: one coverage process per file, batches of $JOBS"
for f in packages/tui/test/pty/*.test.ts; do
  [ -f "$f" ] || continue
  d="$pty_cov_root/$(basename "$f")"
  mkdir -p "$d"
  bun test "${covflags[@]}" --coverage-dir="$d" "$f" < /dev/null > "$LOG_DIR/$(basename "$f").log" 2>&1 &
  pids+=("$!"); files+=("$f"); dirs+=("$d")
  if [ "${#pids[@]}" -ge "$JOBS" ]; then settle; fi
done
settle

n=0
for f in packages/tui/test/pty/*.test.ts; do
  [ -f "$f" ] || continue
  d="$pty_cov_root/$(basename "$f")"
  for info in "$d"/*.info; do
    [ -f "$info" ] || continue
    n=$((n+1))
    mv "$info" "$OUT/pty-$(basename "$f" .test.ts)-$n.info"
  done
  rm -rf "$d"
done
{ cat "$LOG_DIR/results.tsv"; } | sed "s#$PWD/##" > "$OUT/pty-results.tsv"
echo "--- PTY logs: $LOG_DIR"

# --- Summary: per-file totals across all profiles ---------------------------
# (rows outside packages/ and scripts/ are excluded; see the script header)
python3 scripts/ablation-b6-summary.py "$OUT"
echo "--- done: profiles + summary.txt + MANIFEST.txt in $OUT"
