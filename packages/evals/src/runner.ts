/**
 * Eval runner (#524): runs each case of a suite through the real headless
 * path (`moh run --cassette` semantics via runCommand) in an isolated home
 * + temp project root, then scores assertions against the streamed events.
 * Deterministic only: cassettes cover the model side, no live providers.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runCommand } from "../../cli/src/run";
import type { AgentEvent } from "../../core/src/types";
import type { CaseAssertions, EvalCase, FileExpectation, MultiRunCase, RunStep, ToolCallExpectation } from "./case-types";

export interface CaseResult {
  suite: string;
  case: string;
  pass: boolean;
  exitCode: number;
  failures: string[];
}

export interface SuiteResult {
  suite: string;
  cases: CaseResult[];
  pass: number;
  fail: number;
}

const asJson = (v: unknown) => JSON.stringify(v);

function loadCassette(caseDir: string, c: EvalCase["cassette"]): string {
  const file = typeof c === "string" ? join(caseDir, c) : null;
  return file ? readFileSync(file, "utf8") : asJson(c);
}

function captureEvents(raw: string): AgentEvent[] {
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as AgentEvent);
}

/** Ordered subset match: each expected call appears, in order, among actual calls (extras allowed). */
function matchToolCalls(actual: { name: string; args: unknown }[], expected: ToolCallExpectation[]): string[] {
  const failures: string[] = [];
  let i = 0;
  for (const [idx, exp] of expected.entries()) {
    let found = -1;
    while (i < actual.length) {
      if (actual[i]!.name === exp.name) {
        found = i;
        break;
      }
      i += 1;
    }
    if (found === -1) {
      failures.push(
        `toolCalls[${idx}]: expected call "${exp.name}" not found in order; actual: [${actual.map((a) => a.name).join(", ")}]`,
      );
      break;
    }
    if (exp.argsInclude) {
      const args = asJson(actual[found]!.args);
      for (const frag of exp.argsInclude) {
        if (!args.includes(frag)) {
          failures.push(`toolCalls[${idx}] (${exp.name}): args ${args} missing fragment ${asJson(frag)}`);
        }
      }
    }
    i = found + 1;
  }
  return failures;
}

function checkFiles(root: string, files: FileExpectation[]): string[] {
  const failures: string[] = [];
  for (const f of files) {
    const p = join(root, f.path);
    if (f.absent) {
      if (existsSync(p)) failures.push(`files: ${f.path} must not exist but does`);
      continue;
    }
    if (!existsSync(p)) {
      failures.push(`files: ${f.path} does not exist`);
      continue;
    }
    const content = readFileSync(p, "utf8");
    if (content.length === 0) failures.push(`files: ${f.path} is empty`);
    if (f.content !== undefined && content !== f.content) {
      failures.push(`files: ${f.path}\n  expected: ${asJson(f.content)}\n  received: ${asJson(content)}`);
    }
  }
  return failures;
}

function materializeSetup(root: string, setup: Record<string, string> | undefined): void {
  for (const [path, content] of Object.entries(setup ?? {})) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** One headless run against the isolated root; returns exit code + streamed events. */
interface RunOutput {
  exitCode: number;
  events: AgentEvent[];
  stderr: string;
}

async function headlessRun(
  root: string,
  home: string,
  caseDir: string,
  step: Pick<RunStep, "prompt" | "cassette" | "permissions" | "flags" | "fork">,
  sessionFile?: string,
): Promise<RunOutput> {
  writeFileSync(join(root, "cassette.json"), loadCassette(caseDir, step.cassette));
  const chunks: string[] = [];
  const stderr: string[] = [];
  const argv = [
    "run",
    "--cassette",
    "cassette.json",
    "--cwd",
    root,
    ...(step.permissions?.allow ?? []).flatMap((r) => ["--allow", r]),
    ...(step.permissions?.deny ?? []).flatMap((r) => ["--deny", r]),
    ...(sessionFile ? ["--session", sessionFile] : []),
    ...(sessionFile && step.fork ? ["--fork"] : []),
    ...(step.flags ?? []),
    step.prompt,
  ];
  const exitCode = await runCommand({
    argv,
    cwd: root,
    home,
    stdout: { write: (s: string) => (chunks.push(s), true) } as unknown as NodeJS.WritableStream,
    stderr: { write: (s: string) => (stderr.push(s), true) } as unknown as NodeJS.WritableStream,
  });
  return { exitCode, events: captureEvents(chunks.join("")), stderr: stderr.join("") };
}

/** Scores one run's assertions against its streamed events + filesystem. */
function scoreAssertions(want: CaseAssertions, run: RunOutput, root: string): string[] {
  const failures: string[] = [];
  const toolCalls = run.events
    .filter((e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call")
    .map((e) => ({ name: e.name, args: e.args }));
  const denials = run.events.filter(
    (e): e is Extract<AgentEvent, { type: "permission_denied" }> => e.type === "permission_denied",
  );
  const deniedResults = run.events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result" && !e.ok,
  );
  const reply = run.events
    .filter((e): e is Extract<AgentEvent, { type: "assistant_delta" }> => e.type === "assistant_delta")
    .map((e) => e.text)
    .join("");

  if (want.exitCode !== undefined ? run.exitCode !== want.exitCode : run.exitCode !== 0) {
    failures.push(`exitCode: expected ${want.exitCode ?? 0}, got ${run.exitCode} (stderr: ${run.stderr.trim()})`);
  }
  if (want.toolCalls) failures.push(...matchToolCalls(toolCalls, want.toolCalls));
  if (want.files) failures.push(...checkFiles(root, want.files));
  if (want.denials) {
    for (const [idx, d] of want.denials.entries()) {
      const hit = denials.some((e) => e.tool === d.tool && e.reason === d.reason);
      if (!hit) {
        failures.push(
          `denials[${idx}]: no permission_denied for tool "${d.tool}" reason "${d.reason}"; actual: [${denials.map((e) => `${e.tool}/${e.reason}`).join(", ")}]`,
        );
      }
    }
    // A denied call must produce a failed tool_result the model sees.
    if (want.denials.length > 0 && deniedResults.length === 0) {
      failures.push("denials: expected a failed tool_result for the denied call, none found");
    }
  }
  for (const t of want.forbiddenTools ?? []) {
    if (toolCalls.some((tc) => tc.name === t)) failures.push(`forbiddenTools: tool "${t}" was called`);
  }
  for (const frag of want.forbiddenPaths ?? []) {
    const offenders = toolCalls.filter((tc) => ["write", "edit"].includes(tc.name) && asJson(tc.args).includes(frag));
    if (offenders.length > 0) failures.push(`forbiddenPaths: fragment ${asJson(frag)} touched by ${offenders.map((o) => o.name).join(", ")}`);
  }
  for (const frag of want.replyIncludes ?? []) {
    if (!reply.includes(frag)) failures.push(`replyIncludes: ${asJson(frag)} not in reply ${asJson(reply.slice(0, 300))}`);
  }
  return failures;
}

/** One eval run: isolated home + temp project root, real headless path. */
export async function runCase(suite: string, name: string, c: EvalCase): Promise<CaseResult> {
  const dir = mkdtempSync(join(tmpdir(), `moh-eval-`));
  const root = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const caseDir = join(import.meta.dir, "..", "suites", suite);
  materializeSetup(root, c.setup);

  let run: RunOutput;
  try {
    run = await headlessRun(root, home, caseDir, c);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { suite, case: name, pass: false, exitCode: -1, failures: [`runner threw: ${String(e)}`] };
  }
  const failures = scoreAssertions(c.assertions ?? {}, run, root);
  rmSync(dir, { recursive: true, force: true });
  return { suite, case: name, pass: failures.length === 0, exitCode: run.exitCode, failures };
}

function sessionFilesUnder(projects: string): string[] {
  if (!existsSync(projects)) return [];
  const out: string[] = [];
  for (const slug of readdirSync(projects)) {
    const d = join(projects, slug);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".jsonl")) out.push(join(d, f));
  }
  return out;
}

/**
 * Multi-run eval case: step 1 starts a session, later steps resume or fork
 * it via --session. Session assertions score the full event log across runs.
 */
export async function runMultiStepCase(suite: string, name: string, c: MultiRunCase): Promise<CaseResult> {
  const dir = mkdtempSync(join(tmpdir(), `moh-eval-`));
  const root = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const caseDir = join(import.meta.dir, "..", "suites", suite);
  materializeSetup(root, c.setup);

  const failures: string[] = [];
  let lastExit = 0;
  let sessionFile: string | undefined;
  let forkedFile: string | undefined;
  try {
    for (const [i, step] of c.steps.entries()) {
      const before = i === 0 ? [] : sessionFilesUnder(join(home, ".moh", "projects"));
      const file = i === 0 ? undefined : sessionFile;
      const run = await headlessRun(root, home, caseDir, step, file);
      lastExit = run.exitCode;
      if (i === 0) {
        const files = sessionFilesUnder(join(home, ".moh", "projects"));
        if (files.length === 0) failures.push("step 1: no session file created");
        else sessionFile = files[0];
      } else if (step.fork) {
        const created = sessionFilesUnder(join(home, ".moh", "projects")).find((f) => !before.includes(f));
        if (!created) failures.push(`step ${i + 1}: fork produced no new session file`);
        else forkedFile = created;
      }
      lastExit = run.exitCode;
      if (i === 0) {
        const files = sessionFilesUnder(join(home, ".moh", "projects"));
        if (files.length === 0) failures.push("step 1: no session file created");
        else sessionFile = files[0];
      }
      failures.push(...scoreAssertions(step.assertions ?? {}, run, root).map((f) => `step ${i + 1}: ${f}`));
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { suite, case: name, pass: false, exitCode: -1, failures: [`runner threw: ${String(e)}`] };
  }

  if (c.sessionAssertions) {
    const file = forkedFile ?? sessionFile;
    if (file && existsSync(file)) {
      const log = captureEvents(readFileSync(file, "utf8"));
      const sa = c.sessionAssertions;
      if (sa.toolCallOrder) {
        const names = log.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name);
        let i = 0;
        for (const wanted of sa.toolCallOrder) {
          while (i < names.length && names[i] !== wanted) i += 1;
          if (i === names.length) failures.push(`session: tool "${wanted}" not found in order; log: [${names.join(", ")}]`);
          else i += 1;
        }
      }
      for (const t of sa.chromeEvents ?? []) {
        if (!log.some((e) => e.type === t)) failures.push(`session: chrome event "${t}" missing from the log`);
      }
      for (const t of sa.absentChromeEvents ?? []) {
        if (log.some((e) => e.type === t)) failures.push(`session: chrome event "${t}" must not be in the log`);
      }
    } else {
      failures.push("session: no session file to score sessionAssertions against");
    }
  }

  rmSync(dir, { recursive: true, force: true });
  return { suite, case: name, pass: failures.length === 0, exitCode: lastExit, failures };
}

export function listCases(suite: string): string[] {
  const dir = join(import.meta.dir, "..", "suites", suite);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
    .sort();
}

export function suiteNames(): string[] {
  const root = join(import.meta.dir, "..", "suites");
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Dispatches a parsed case file to the right runner shape. */
export async function runCaseFile(suite: string, name: string, spec: EvalCase | MultiRunCase): Promise<CaseResult> {
  return "steps" in spec ? runMultiStepCase(suite, name, spec) : runCase(suite, name, spec);
}
