#!/usr/bin/env bun
/**
 * Lean bench (#1633, "Measurement"): replays a frozen corpus of tasks under
 * three prompt conditions and measures the structural quality of each diff.
 * Dev tooling; nothing in packages/ imports it. See README.md.
 *
 *   bun scripts/lean-bench/bench.ts run    --model <ref> --out <dir> [--runs 3] [--only <id>...] [--conditions a,b]
 *   bun scripts/lean-bench/bench.ts judge  --model <ref> --out <dir>
 *   bun scripts/lean-bench/bench.ts report --out <dir>
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { initCommand } from "../../packages/cli/src/init";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = join(ROOT, "packages/cli/src/cli.ts");
const COMPOSER = "packages/core/src/prompt-composer.ts";
/** develop just before base prompt v3 (#1634): the source of the v2 text. */
const V2_REV = "8f06512d";
const CONDITIONS = ["v2", "v3", "v3+code-quality", "v3+code-quality+apply"] as const;
type Condition = (typeof CONDITIONS)[number];
/** The pre-registered criterion counts these judge smells (README). */
const STRUCTURAL_SMELLS = ["Speculative Generality", "Duplicated Code", "Middle Man"];
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb)$/;
const DECLARATION =
  /^\+\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|def)\s+([A-Za-z_$][\w$]*)/;
const RUN_TIMEOUT_MS = 45 * 60_000;
const JUDGE_DIFF_MAX_CHARS = 60_000;

interface Task {
  id: string;
  repo: string;
  base: string;
  setup?: string;
  strip: string[];
  reference: string;
  prompt: string;
}

interface Metrics {
  exitCode: number | null;
  filesAdded: number;
  linesAdded: number;
  linesDeleted: number;
  uncalledSymbols: string[];
  duplicatesTouchingChange: number | null;
  highCcnFunctions: number | null;
}

function exec(cmd: string, args: string[], cwd: string, timeout?: number, env?: NodeJS.ProcessEnv) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout, env });
}

function sh(cmd: string, args: string[], cwd: string): string {
  const r = exec(cmd, args, cwd);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

/** The BASE_PROMPT text out of a prompt-composer.ts source (one JSON-compatible string per line). */
export function parseBasePrompt(source: string): string {
  const start = source.indexOf("export const BASE_PROMPT = [");
  const body = source.slice(start, source.indexOf('].join("\\n");', start));
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => JSON.parse(line.replace(/,$/, "")) as string)
    .join("\n");
}

/**
 * A history-free snapshot of `repo` at `base`: a worktree would share every
 * ref, and the model could `git log --all` its way to the shipped solution.
 */
function prepare(task: Task, condition: Condition, wt: string): void {
  const repo = resolve(ROOT, task.repo);
  if (exec("git", ["cat-file", "-e", `${task.base}^{commit}`], repo).status !== 0) sh("git", ["fetch", "-q", "origin", task.base], repo);
  mkdirSync(wt, { recursive: true });
  sh("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", repo, task.base, wt], ROOT);
  sh("git", ["init", "-q"], wt);
  // moh's own state (prompt override, project id) is harness, never part of the change.
  writeFileSync(join(wt, ".git/info/exclude"), ".moh/\n");
  for (const path of task.strip) rmSync(join(wt, path), { recursive: true, force: true });
  const source =
    condition === "v2" ? sh("git", ["show", `${V2_REV}:${COMPOSER}`], ROOT) : readFileSync(join(ROOT, COMPOSER), "utf8");
  mkdirSync(join(wt, ".moh/prompts"), { recursive: true });
  writeFileSync(join(wt, ".moh/prompts/system.md"), parseBasePrompt(source));
  if (condition.startsWith("v3+code-quality")) initCommand({ cwd: wt, stdout: new Writable({ write: (_c, _e, done) => done() }) });
  sh("git", ["add", "-A"], wt);
  sh("git", ["-c", "user.name=lean-bench", "-c", "user.email=lean-bench@localhost", "commit", "-q", "--no-verify", "-m", "lean-bench setup"], wt);
  if (task.setup) sh("sh", ["-c", task.setup], wt);
}

/** Diff size and declared symbols with no other occurrence, over the staged change against HEAD. */
export function diffMetrics(wt: string): Pick<Metrics, "filesAdded" | "linesAdded" | "linesDeleted" | "uncalledSymbols"> {
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const row of sh("git", ["diff", "--cached", "--numstat", "HEAD"], wt).split("\n").filter(Boolean)) {
    const [added, deleted] = row.split("\t");
    linesAdded += Number(added) || 0;
    linesDeleted += Number(deleted) || 0;
  }
  const filesAdded = sh("git", ["diff", "--cached", "--name-status", "HEAD"], wt)
    .split("\n")
    .filter((row) => row.startsWith("A\t")).length;
  const names = new Set<string>();
  for (const line of sh("git", ["diff", "--cached", "-U0", "HEAD"], wt).split("\n")) {
    const match = line.startsWith("+++") ? null : DECLARATION.exec(line);
    if (match) names.add(match[1]!);
  }
  const uncalledSymbols = [...names].filter((name) => {
    const r = exec("git", ["grep", "--cached", "-w", "-c", "-F", name], wt);
    const occurrences = r.stdout.split("\n").reduce((sum, row) => sum + (Number(row.split(":").pop()) || 0), 0);
    return occurrences <= 1;
  });
  return { filesAdded, linesAdded, linesDeleted, uncalledSymbols: uncalledSymbols.sort() };
}

function changedCodeFiles(wt: string): string[] {
  return sh("git", ["diff", "--cached", "--name-only", "--diff-filter=AM", "HEAD"], wt)
    .split("\n")
    .filter((file) => CODE_FILE.test(file));
}

/** jscpd clones with at least one fragment in a changed file; null when the tool fails. */
function duplicatesTouchingChange(wt: string, changed: string[]): number | null {
  if (changed.length === 0) return 0;
  const out = mkdtempSync(join(tmpdir(), "jscpd-"));
  try {
    exec("npx", ["--yes", "jscpd@4.0.5", "--silent", "--gitignore", "--min-tokens", "50", "--reporters", "json", "--output", out, "."], wt);
    const report = join(out, "jscpd-report.json");
    if (!existsSync(report)) return null;
    const clones = (JSON.parse(readFileSync(report, "utf8")) as { duplicates: { firstFile: { name: string }; secondFile: { name: string } }[] }).duplicates;
    const touched = new Set(changed);
    return clones.filter((c) => touched.has(c.firstFile.name) || touched.has(c.secondFile.name)).length;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** lizard functions with cyclomatic complexity above 10 in the changed files; null when the tool fails. */
function highCcnFunctions(wt: string, changed: string[]): number | null {
  if (changed.length === 0) return 0;
  const r = exec("uvx", ["--from", "lizard==1.17.10", "lizard", "--csv", ...changed], wt);
  if (r.status !== 0 && !r.stdout) return null;
  return r.stdout.split("\n").filter((row) => Number(row.split(",")[1]) > 10).length;
}

/**
 * `moh run` under a throwaway HOME holding the user's ~/.moh/config
 * (endpoints and credentials) with auto-lanes off: a lane worktree would not
 * carry the gitignored `.moh/prompts/system.md` and would move the edits out
 * of the cell. No user sessions, skills or extensions reach a run, and HOME
 * never points the model at the bench's output.
 */
function mohRun(args: string[], cwd: string) {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".moh", "config"), "utf8")) as { lanes?: object };
    mkdirSync(join(home, ".moh"));
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ ...config, lanes: { ...config.lanes, auto: false } }), { mode: 0o600 });
    return exec("bun", [CLI, "run", "--cwd", cwd, ...args], cwd, RUN_TIMEOUT_MS, { ...process.env, HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The code-review skill in apply mode over the uncommitted change, framed as moh frames a skill turn. */
function applyPrompt(): string {
  const skill = readFileSync(join(ROOT, "packages/core/assets/skills/code-review/SKILL.md"), "utf8");
  const body = skill.slice(skill.indexOf("\n---", 3) + 4).trim();
  return `Follow the "code-review" skill for this turn. Its instructions are reproduced verbatim below.\n\n${body}\n\n---\n\napply HEAD`;
}

function runCell(task: Task, condition: Condition, model: string, cell: string): void {
  const wt = join(mkdtempSync(join(tmpdir(), "task-")), "repo");
  try {
    prepare(task, condition, wt);
    const r = mohRun(["--provider", model, "--auto-accept", "-p", task.prompt], wt);
    mkdirSync(cell, { recursive: true });
    writeFileSync(join(cell, "events.jsonl"), r.stdout ?? "");
    // #1633 slice 2: the construction-time pass, as /implement runs it — a fresh
    // session over the change only, judged on the end state.
    if (condition.endsWith("+apply")) writeFileSync(join(cell, "apply-events.jsonl"), mohRun(["--provider", model, "--auto-accept", "-p", applyPrompt()], wt).stdout ?? "");
    sh("git", ["add", "-A"], wt);
    writeFileSync(join(cell, "diff.patch"), sh("git", ["diff", "--cached", "HEAD"], wt));
    const changed = changedCodeFiles(wt);
    const metrics: Metrics = {
      exitCode: r.status,
      ...diffMetrics(wt),
      duplicatesTouchingChange: duplicatesTouchingChange(wt, changed),
      highCcnFunctions: highCcnFunctions(wt, changed),
    };
    writeFileSync(join(cell, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  } finally {
    rmSync(dirname(wt), { recursive: true, force: true });
  }
}

function cells(out: string): { task: string; condition: string; dir: string }[] {
  const found = [];
  for (const task of readdirSync(out)) {
    for (const condition of CONDITIONS) {
      const dir = join(out, task, condition);
      if (!existsSync(dir)) continue;
      for (const run of readdirSync(dir)) found.push({ task, condition, dir: join(dir, run) });
    }
  }
  return found;
}

function judgePrompt(diff: string): string {
  const skill = readFileSync(join(ROOT, "packages/core/assets/skills/code-review/SKILL.md"), "utf8");
  const smells = skill.split("\n").filter((line) => /^- \*\*[A-Z][\w ]+\*\*:/.test(line));
  return [
    "You are classifying structural code smells in a diff. Do not use any tool.",
    "Apply this smell baseline (Fowler, Refactoring ch.3). Each finding is a judgement call; report only smells the diff itself introduces.",
    ...smells,
    "",
    'Reply with one JSON object and nothing else: {"findings":[{"smell":"<smell name as above>","where":"<path:line>"}]}. An empty list is a valid answer.',
    "",
    "```diff",
    diff.length > JUDGE_DIFF_MAX_CHARS ? `${diff.slice(0, JUDGE_DIFF_MAX_CHARS)}\n[diff truncated]` : diff,
    "```",
  ].join("\n");
}

/** The assistant text of a `moh run` JSONL stream. */
function assistantText(jsonl: string): string {
  return jsonl
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { type: string; text?: string })
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.text)
    .join("");
}

function judge(out: string, model: string): void {
  // Shuffled, and run from an empty directory with the diff only: the judge never sees the condition.
  const pending = cells(out)
    .filter((c) => existsSync(join(c.dir, "diff.patch")) && !existsSync(join(c.dir, "judge.json")))
    .sort(() => Math.random() - 0.5);
  for (const c of pending) {
    const cwd = mkdtempSync(join(tmpdir(), "review-"));
    const prompt = judgePrompt(readFileSync(join(c.dir, "diff.patch"), "utf8"));
    const r = mohRun(["--provider", model, "--deny", "bash", "--deny", "write", "--deny", "edit", "-p", prompt], cwd);
    rmSync(cwd, { recursive: true, force: true });
    const text = assistantText(r.stdout ?? "");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try {
      writeFileSync(join(c.dir, "judge.json"), `${JSON.stringify(JSON.parse(json), null, 2)}\n`);
    } catch {
      console.error(`judge: unparseable answer for ${c.dir}`);
    }
  }
}

const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN);

/** Per-condition means of per-task means, then the pre-registered verdict. */
function report(out: string): void {
  const columns = ["linesAdded", "filesAdded", "uncalled", "duplicates", "highCcn", "structural"] as const;
  const perTask = new Map<string, Map<string, Record<(typeof columns)[number], number>[]>>();
  for (const c of cells(out)) {
    const metricsFile = join(c.dir, "metrics.json");
    const judgeFile = join(c.dir, "judge.json");
    if (!existsSync(metricsFile) || !existsSync(judgeFile)) continue;
    const m = JSON.parse(readFileSync(metricsFile, "utf8")) as Metrics;
    const j = JSON.parse(readFileSync(judgeFile, "utf8")) as { findings: { smell: string }[] };
    const row = {
      linesAdded: m.linesAdded,
      filesAdded: m.filesAdded,
      uncalled: m.uncalledSymbols.length,
      duplicates: m.duplicatesTouchingChange ?? Number.NaN,
      highCcn: m.highCcnFunctions ?? Number.NaN,
      structural: j.findings.filter((f) => STRUCTURAL_SMELLS.includes(f.smell)).length,
    };
    const byCondition = perTask.get(c.condition) ?? new Map();
    byCondition.set(c.task, [...(byCondition.get(c.task) ?? []), row]);
    perTask.set(c.condition, byCondition);
  }
  const summary = new Map<string, Record<(typeof columns)[number], number>>();
  console.log(["condition", "tasks", ...columns].join("\t"));
  for (const condition of CONDITIONS) {
    const byTask = [...(perTask.get(condition)?.values() ?? [])];
    const row = Object.fromEntries(columns.map((col) => [col, mean(byTask.map((runs) => mean(runs.map((r) => r[col]))))])) as Record<(typeof columns)[number], number>;
    summary.set(condition, row);
    console.log([condition, byTask.length, ...columns.map((col) => row[col].toFixed(2))].join("\t"));
  }
  // The pre-registered criteria (README): each prints only when both of its conditions are complete.
  const complete = (condition: string) => {
    const row = summary.get(condition)!;
    return Object.values(row).some(Number.isNaN) ? undefined : row;
  };
  // A baseline with no structural findings leaves nothing to cut.
  const cut = (base: Record<string, number>, treated: Record<string, number>) => (base.structural === 0 ? 1 : 1 - treated.structural / base.structural);
  let verdicts = 0;
  const v2 = complete("v2");
  const lean = complete("v3+code-quality");
  const applied = complete("v3+code-quality+apply");
  if (v2 && lean) {
    verdicts++;
    const noWorse = lean.uncalled <= v2.uncalled && lean.duplicates <= v2.duplicates && lean.highCcn <= v2.highCcn;
    console.log(`\nstructural findings cut (v3+code-quality vs v2): ${(cut(v2, lean) * 100).toFixed(0)}%; deterministic metrics no worse: ${noWorse}`);
    console.log(cut(v2, lean) >= 0.5 && noWorse ? "verdict: slice 4 archived" : "verdict: slice 4 justified");
  }
  if (lean && applied) {
    verdicts++;
    const noLarger = applied.linesAdded <= lean.linesAdded;
    console.log(`\nstructural findings cut (apply vs v3+code-quality): ${(cut(lean, applied) * 100).toFixed(0)}%; lines added no higher: ${noLarger}`);
    console.log(cut(lean, applied) >= 0.3 && noLarger ? "verdict: apply stays in /implement" : "verdict: revert the /implement hook; apply stays on demand");
  }
  if (verdicts === 0) {
    console.log("\nverdict: incomplete data (a criterion needs both of its conditions judged, with tool metrics)");
    process.exitCode = 1;
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const out = flag(args, "--out");
  const model = flag(args, "--model");
  if (!out || (command !== "report" && !model) || !["run", "judge", "report"].includes(command ?? "")) {
    console.error("usage: bench.ts run|judge --model <ref> --out <dir> [--runs n] [--only id...] [--conditions a,b] | report --out <dir>");
    process.exit(2);
  }
  if (command === "report") report(out);
  if (command === "judge") judge(out, model!);
  if (command === "run") {
    const only = args.flatMap((arg, i) => (args[i - 1] === "--only" ? [arg] : []));
    const tasks = (JSON.parse(readFileSync(join(import.meta.dir, "corpus.json"), "utf8")) as Task[]).filter(
      (task) => only.length === 0 || only.includes(task.id),
    );
    const runs = Number(flag(args, "--runs") ?? 3);
    const picked = flag(args, "--conditions")?.split(",");
    const conditions = CONDITIONS.filter((c) => !picked || picked.includes(c));
    // Runs interleave tasks and conditions so provider drift spreads evenly; existing cells are kept (resumable).
    for (let n = 1; n <= runs; n++) {
      for (const task of tasks) {
        for (const condition of conditions) {
          const cell = join(out, task.id, condition, String(n));
          if (existsSync(join(cell, "metrics.json"))) continue;
          console.error(`run ${n}/${runs} ${task.id} ${condition}`);
          runCell(task, condition, model!, cell);
        }
      }
    }
  }
}
