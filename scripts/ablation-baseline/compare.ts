// Standalone tree compare for every ablation baseline: exits non-zero on
// ANY difference (missing/extra files, byte differences, up to 5 line
// previews per file). Imports nothing from the repo's packages — a broken
// build must not break the comparator.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function walk(root: string, base = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

const [dirA, dirB] = process.argv.slice(2);
if (!dirA || !dirB) {
  console.error("usage: compare.ts <dirA> <dirB>");
  process.exit(2);
}

let diffs = 0;
const filesA = new Set(walk(dirA));
const filesB = new Set(walk(dirB));
for (const f of filesA) if (!filesB.has(f)) {
  diffs += 1;
  console.log(`DIFF only in ${dirA}: ${f}`);
}
for (const f of filesB) if (!filesA.has(f)) {
  diffs += 1;
  console.log(`DIFF only in ${dirB}: ${f}`);
}
for (const f of filesA) {
  if (!filesB.has(f)) continue;
  const textA = readFileSync(join(dirA, f), "utf8");
  const textB = readFileSync(join(dirB, f), "utf8");
  if (textA === textB) continue;
  diffs += 1;
  console.log(`DIFF ${f}`);
  const linesA = textA.split("\n");
  const linesB = textB.split("\n");
  let shown = 0;
  for (let i = 0; i < Math.max(linesA.length, linesB.length) && shown < 5; i++) {
    if (linesA[i] !== linesB[i]) {
      console.log(`  line ${i + 1}:`);
      console.log(`    A: ${linesA[i] ?? "<missing>"}`);
      console.log(`    B: ${linesB[i] ?? "<missing>"}`);
      shown += 1;
    }
  }
}
if (diffs === 0) {
  console.log(`compare: identical (${[...filesA].length} files)`);
  process.exit(0);
}
console.log(`compare: ${diffs} difference(s)`);
process.exit(1);
