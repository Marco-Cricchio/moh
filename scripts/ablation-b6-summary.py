#!/usr/bin/env python3
"""B6 per-file coverage summary over a directory of lcov profiles.

Usage: python3 scripts/ablation-b6-summary.py <profilesDir> [<summaryPath>]

Writes the summary (one row per repo file: lines, lines_hit) to
<summaryPath> (default: <profilesDir>/summary.txt) and prints the totals.
Line coverage only: Bun 1.2.19 lcov emits no FN/FNDA records, so there
are no function columns. Rows outside packages/ and scripts/ (temp
fixtures loaded from outside the repo) are excluded from the map.

Called by scripts/ablation-coverage.sh as its summary step; runnable
stand-alone to regenerate the summary from recorded profiles without
touching the profile directory:
  python3 scripts/ablation-b6-summary.py ~/moh-ablation-baselines/1387-b6 /tmp/b6-new/summary.txt
"""
import glob
import os
import sys
from collections import defaultdict

if len(sys.argv) not in (2, 3):
    sys.exit("usage: ablation-b6-summary.py <profilesDir> [<summaryPath>]")
out = sys.argv[1]
summary_path = sys.argv[2] if len(sys.argv) == 3 else os.path.join(out, "summary.txt")

# DA line hits accumulate across processes (max hits per line).
lines = {}  # (sf, ln) -> max hits seen
for path in sorted(glob.glob(os.path.join(out, "*.info"))):
    sf = None
    for raw in open(path):
        line = raw.rstrip("\n")
        if line.startswith("SF:"):
            sf = line[3:]
        elif line.startswith("DA:") and sf is not None:
            ln, hits = line[3:].split(",", 1)
            key = (sf, int(ln))
            h = int(hits)
            if key not in lines or h > lines[key]:
                lines[key] = h
        elif line == "end_of_record":
            sf = None

by_file = defaultdict(lambda: [0, 0])  # lines, lines-hit
for (sf, ln), h in lines.items():
    by_file[sf][0] += 1
    if h > 0:
        by_file[sf][1] += 1

rows = []
for sf, (lf, lh) in by_file.items():
    if not sf.startswith(("packages/", "scripts/")):
        continue  # temp fixtures outside the repo are not part of the map
    rows.append((sf, lf, lh))
rows.sort()
with open(summary_path, "w") as w:
    w.write("file\tlines\tlines_hit\n")
    for sf, lf, lh in rows:
        w.write(f"{sf}\t{lf}\t{lh}\n")
total_l = sum(r[1] for r in rows)
total_lh = sum(r[2] for r in rows)
print(f"summary: {len(rows)} files, {total_lh}/{total_l} lines hit ({100.0*total_lh/max(total_l,1):.1f}%)")
print(f"summary written: {summary_path}")
