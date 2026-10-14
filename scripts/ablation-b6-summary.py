#!/usr/bin/env python3
"""B6 per-file coverage summary over a directory of lcov profiles.

Usage: python3 scripts/ablation-b6-summary.py <profilesDir>

Writes <profilesDir>/summary.txt (one row per repo file: funcs,
funcs_hit, lines, lines_hit) and prints the totals. Rows outside
packages/ and scripts/ (temp fixtures loaded from outside the repo)
are excluded from the map.

Called by scripts/ablation-coverage.sh as its summary step; runnable
stand-alone to regenerate the summary from recorded profiles, e.g.:
  python3 scripts/ablation-b6-summary.py ~/moh-ablation-baselines/1387-b6
"""
import glob
import os
import sys
from collections import defaultdict

if len(sys.argv) != 2:
    sys.exit("usage: ablation-b6-summary.py <profilesDir>")
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
            if int(line[5:].split(",")[0]) > 0:
                funcs_hit[sf].add(int(line[5:].split(",")[1]))
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
