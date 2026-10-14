#!/usr/bin/env bash
# B6 coverage collection through the repository's phased runner: the
# component phase and every PTY process run in their own `bun test
# --coverage` process, never overlapping (00-safety-net § 2, B6; #1387).
#
#   scripts/ablation-coverage.sh <outDir>
#
# Writes per-phase lcov profiles under <outDir>/ (one file per process:
# `component-NNN.info`, `pty-<file>.info`) plus `summary.txt` (per-file
# totals) and `MANIFEST.txt` (commit, tool versions, exact commands).
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
pty_cov_root="$OUT/pty"
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
python3 - "$OUT" <<'PYEOF'
import glob, os, sys
from collections import defaultdict

out = sys.argv[1]
# DA line hits accumulate across processes; FN/FNF/FNH per record.
lines = {}  # (sf, ln) -> max hits seen
funcs_found = defaultdict(set)
funcs_hit = defaultdict(set)
for path in sorted(glob.glob(os.path.join(out, "*.info"))):
    sf = None
    for raw in open(path):
        line = raw.rstrip("\n")
        if line.startswith("SF:"):
            sf = line[3:]
        elif line.startswith("FN:") and sf is not None:
            ln, name = line[3:].split(",", 1)
            funcs_found[sf].add(int(ln))
        elif line.startswith("FNDA:") and sf is not None:
            ln, name = line[5:].split(",", 1)
            if int(line[5:].split(",")[0]) > 0:
                funcs_hit[sf].add(int(ln))
        elif line.startswith("DA:") and sf is not None:
            ln, hits = line[3:].split(",", 1)
            key = (sf, int(ln))
            h = int(hits)
            if key not in lines or h > lines[key]:
                lines[key] = h
        elif line == "end_of_record":
            sf = None

by_file = defaultdict(lambda: [0, 0, 0, 0])  # found, hit, lines, lines-hit
for (sf, ln), h in lines.items():
    by_file[sf][2] += 1
    if h > 0:
        by_file[sf][3] += 1
for sf, lns in funcs_found.items():
    by_file[sf][0] += len(lns)
    by_file[sf][1] += len(funcs_hit[sf] & {l for l in funcs_found[sf]})

rows = []
for sf, (ff, fh, lf, lh) in by_file.items():
    if not sf.startswith(("packages/", "scripts/")):
        continue  # temp fixtures outside the repo are not part of the map
    rows.append((sf, ff, fh, lf, lh))
rows.sort()
with open(os.path.join(out, "summary.txt"), "w") as w:
    w.write("file\tfuncs\tfuncs_hit\tlines\tlines_hit\n")
    for sf, ff, fh, lf, lh in rows:
        w.write(f"{sf}\t{ff}\t{fh}\t{lf}\t{lh}\n")
total_l = sum(r[3] for r in rows)
total_lh = sum(r[4] for r in rows)
print(f"summary: {len(rows)} files, {total_lh}/{total_l} lines hit ({100.0*total_lh/max(total_l,1):.1f}%)")
print(f"summary written: {os.path.join(out, 'summary.txt')}")
PYEOF
echo "--- done: profiles + summary.txt + MANIFEST.txt in $OUT"
