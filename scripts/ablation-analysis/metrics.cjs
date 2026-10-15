#!/usr/bin/env node
// S0.4 starting-metrics calculator: prints every STARTING-METRICS.md row
// with its definition and the measured value (#1387). Standalone — reads
// the repo tree, scripts/ablation-analysis/out/refs.json (run refs.cjs
// first for the rows that need it; rows report "n/a" without it) and
// scripts/ablation-analysis/out/b6/summary.txt (the B6 rows are skipped
// when it is absent).
//
//   node scripts/ablation-analysis/metrics.cjs
//
// Definitions are printed inline; the same text appears in
// STARTING-METRICS.md. TypeScript from packages/core/node_modules (5.9 —
// the root typescript@7 has no JS API).
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
const ts = require(path.join(REPO, "packages/core/node_modules/typescript"));

const rows = [];
function row(metric, definition, value, command) {
  rows.push({ metric, definition, value: String(value), command });
}

function namedExportSpecifiers(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(path.join(REPO, file), "utf8"), ts.ScriptTarget.ES2022, true);
  let n = 0;
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause) continue;
    if (ts.isNamedExports(st.exportClause)) n += st.exportClause.elements.length;
  }
  return n;
}

// --- refs.json-dependent rows ------------------------------------------------
let refs = null;
try {
  refs = JSON.parse(fs.readFileSync(path.join(__dirname, "out", "refs.json"), "utf8"));
} catch {}

function reportCount(mode) {
  if (!refs) return "n/a";
  const src = refs.filter((r) => r.srcFile);
  const dead = src.filter((r) => r.exported && r.extSrc.length === 0 && r.extTest.length === 0 && (!r.extExample || r.extExample.length === 0) && r.ownUses === 0);
  const testonly = src.filter((r) => r.exported && r.extSrc.length === 0 && r.extExample.length === 0 && r.extTest.length > 0 && r.ownUses === 0);
  const exampleonly = src.filter((r) => r.exported && r.extSrc.length === 0 && r.extTest.length === 0 && r.extExample.length > 0 && r.ownUses === 0);
  const localonly = src.filter((r) => r.exported && r.extSrc.length === 0 && r.ownUses > 0);
  const privatedead = src.filter((r) => !r.exported && r.ownUses === 0 && r.extSrc.length === 0 && r.extTest.length === 0 && r.kind !== "Property" && r.name !== "constructor");
  const optional = src.filter((r) => {
    if (!r.params || r.calls === 0) return false;
    const max = Math.max(...r.callArgCounts);
    return r.params.some((p, i) => p.optional && i >= max && !p.name.startsWith("..."));
  });
  return { dead, testonly, exampleonly, localonly, privatedead, optional }[mode].length;
}

// --- git-tracked source file set ----------------------------------------------
function gitSourceFiles() {
  return cp.execSync('git ls-files -- "packages/*.ts" "packages/*.tsx" "scripts/*.ts"', { cwd: REPO })
    .toString().trim().split("\n")
    .filter((f) => !/\.test\.|\/test\/|\.d\.ts$/.test(f));
}

// --- provider-kind AST literals ------------------------------------------------
const KINDS = ["anthropic", "openai", "google", "github-copilot", "openrouter", "kimi-coding", "xai"];
function providerKindCounts() {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && !e.name.endsWith(".d.ts")) files.push(p);
    }
  })(path.join(REPO, "packages/core/src"));
  const out = {};
  for (const k of KINDS) out[k] = 0;
  for (const f of files) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.ES2022, true);
    const seen = new Set();
    (function visit(n) {
      if (ts.isStringLiteral(n) && KINDS.includes(n.text)) seen.add(n.text);
      ts.forEachChild(n, visit);
    })(sf);
    for (const k of seen) out[k] += 1;
  }
  return out;
}

// --- compute -------------------------------------------------------------------
const analysisCmd = "node scripts/ablation-analysis/refs.cjs . scripts/ablation-analysis/out";

row("core index export names",
  "named export specifiers in packages/core/src/index.ts (TS AST)",
  namedExportSpecifiers("packages/core/src/index.ts"),
  "node scripts/ablation-analysis/metrics.cjs");

row("core index lines",
  "wc -l of packages/core/src/index.ts",
  fs.readFileSync(path.join(REPO, "packages/core/src/index.ts"), "utf8").split("\n").length - (fs.readFileSync(path.join(REPO, "packages/core/src/index.ts"), "utf8").endsWith("\n") ? 1 : 0),
  "wc -l packages/core/src/index.ts");

row("tui index export names",
  "named export specifiers in packages/tui/src/index.ts (TS AST)",
  namedExportSpecifiers("packages/tui/src/index.ts"),
  "node scripts/ablation-analysis/metrics.cjs");

row("dead (exported top-level, zero refs anywhere incl. tests)",
  "refs.json: exported && extSrc=0 && extTest=0 && extExample=0 && ownUses=0, source files only",
  reportCount("dead"),
  analysisCmd + " && node scripts/ablation-analysis/report.cjs dead");

row("testonly (exports reachable only from tests)",
  "refs.json: exported, no src/example referrer, >=1 test referrer, no own use",
  reportCount("testonly"),
  analysisCmd + " && node scripts/ablation-analysis/report.cjs testonly");

row("exampleonly (symbols reached only from runnable examples)",
  "refs.json: exported, no src/test referrer, >=1 example referrer, no own use",
  reportCount("exampleonly"),
  analysisCmd + " && node scripts/ablation-analysis/report.cjs exampleonly");

row("localonly (exported, only used inside own file)",
  "refs.json: exported, no external src referrer, ownUses>0 (tests allowed)",
  reportCount("localonly"),
  analysisCmd + " && node scripts/ablation-analysis/report.cjs localonly");

row("privatedead (non-exported, never referenced)",
  "refs.json: !exported, no referrer anywhere, kind!=Property, name!=constructor",
  reportCount("privatedead"),
  analysisCmd + " && node scripts/ablation-analysis/report.cjs privatedead");

row("optional (functions with never-passed optional params)",
  "refs.json: params optional && p.i >= max(callArgCounts) && calls>0",
  reportCount("optional"),
  analysisCmd + " && node scripts/ablation-analysis/report.cjs optional");

row("refs.json declarations",
  "collected declarations (top-level + class methods + example files)",
  refs ? refs.length : "n/a",
  analysisCmd + "  # last output line");

if (refs) {
  const srcFiles = refs.filter((r) => r.srcFile);
  const localZero = srcFiles.filter((r) =>
    r.file.startsWith("packages/") && !r.file.startsWith("packages/extension/") &&
    r.exported && r.top && r.extSrc.length === 0 && r.extTest.length === 0 &&
    (!r.extExample || r.extExample.length === 0) && r.ownUses === 0);
  row("file-local exported, zero refs anywhere, excluding @moh/extension",
    "refs.json: exported && top, extSrc=0 && extTest=0 && extExample=0 && ownUses=0, file under packages/ but not packages/extension/",
    localZero.length,
    "node scripts/ablation-analysis/metrics.cjs");

  const coreSrc = new Set(srcFiles.filter((r) => r.file.startsWith("packages/core/src/")).map((r) => r.file));
  row("core source files",
    "distinct file values under packages/core/src/ in refs.json",
    coreSrc.size,
    "node scripts/ablation-analysis/metrics.cjs");
}

const gitFiles = gitSourceFiles();
let splitLines = 0;
for (const f of gitFiles) splitLines += fs.readFileSync(path.join(REPO, f), "utf8").split("\n").length;
row("source files excluding tests",
  'git ls-files -- "packages/*.ts" "packages/*.tsx" "scripts/*.ts", excluding *.test.*, */test/*, *.d.ts',
  gitFiles.length,
  "node scripts/ablation-analysis/metrics.cjs");
row("source lines excluding tests",
  'split("\\n") line count (wc -l + 1 per file with a final unterminated line) over the same file set',
  splitLines,
  "node scripts/ablation-analysis/metrics.cjs");

const kinds = providerKindCounts();
row("provider-kind lists (7 OAuth kinds): files per kind with the kind as an exact TS string literal",
  "packages/core/src non-test files containing the kind as an exact TS string literal (TS AST), counted per kind: " + KINDS.map((k) => `${k} ${kinds[k]}`).join(", "),
  Math.min(...Object.values(kinds)) + "-" + Math.max(...Object.values(kinds)),
  "node scripts/ablation-analysis/metrics.cjs");

const grep = cp.execSync('grep -rn "renameSync" packages/cli/src packages/core/src packages/evals/src packages/extension/src packages/jev-guard/src packages/team/src packages/tui/src || true', { cwd: REPO }).toString();
const grepLines = grep.trim() ? grep.trim().split("\n") : [];
const grepFiles = new Set(grepLines.map((l) => l.split(":")[0]));
row("atomic write sites",
  "every non-test occurrence of renameSync under packages/*/src",
  `${grepFiles.size} files, ${grepLines.length} occurrences`,
  'grep -rn "renameSync" packages/*/src | grep -v /test/');

const summaryPath = path.join(__dirname, "out", "b6", "summary.txt");
if (fs.existsSync(summaryPath)) {
  const srows = fs.readFileSync(summaryPath, "utf8").trim().split("\n").slice(1);
  const sum = (pred) => {
    const r = srows.filter(pred);
    return [r.length, r.reduce((a, x) => a + parseInt(x.split("\t")[2], 10), 0), r.reduce((a, x) => a + parseInt(x.split("\t")[1], 10), 0)];
  };
  const all = sum(() => true);
  const testFiles = sum((r) => r.startsWith("packages/") && r.includes("/test/"));
  const scriptsFiles = sum((r) => r.startsWith("scripts/"));
  const srcOnly = sum((r) => r.startsWith("packages/") && r.includes("/src/") && !r.includes("/test/"));
  row("B6 map (all rows)",
    "out/b6/summary.txt rows: repo files incl. test-support and scripts support files",
    `${all[0]} files, ${all[1]}/${all[2]} lines hit (${(100.0 * all[1] / all[2]).toFixed(1)}%)`,
    "python3 scripts/ablation-b6-summary.py ~/moh-ablation-baselines/1387-b6 <fresh>/summary.txt");
  row("B6 map breakdown",
    "rows under packages/*/test/ vs rows under scripts/",
    `${testFiles[0]} test-support files, ${scriptsFiles[0]} scripts files`,
    "node scripts/ablation-analysis/metrics.cjs");
  row("B6 map source-only view",
    "rows under packages/*/src only",
    `${srcOnly[0]} files, ${srcOnly[1]}/${srcOnly[2]} lines hit (${(100.0 * srcOnly[1] / srcOnly[2]).toFixed(1)}%)`,
    "awk -F'\\t' 'NR>1 && $1!~/\\/test\\// && $1!~/^scripts\\//{n++;l+=$2;h+=$3} END{print n,h\"/\"l}' scripts/ablation-analysis/out/b6/summary.txt");
}

console.log("S0.4 starting metrics (definitions inline) — run from the repo root");
console.log("analysis inputs: refs.json via: " + analysisCmd);
for (const r of rows) {
  console.log("\n## " + r.metric);
  console.log("definition: " + r.definition);
  console.log("value:      " + r.value);
  console.log("command:    " + r.command);
}
