/**
 * Eval harness entry point (#524):
 *   bun packages/evals/run.ts [--suite <name>] [--filter <pattern>] [--json]
 *
 * Exits non-zero when any assertion fails. A suite file (suites/<name>.suite.json)
 * pins the expected pass count so a change that breaks cases fails loudly even
 * if the suite directory drifts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listCases, runCaseFile, suiteNames, type CaseResult, type SuiteResult } from "./src/runner";
import type { EvalCase, MultiRunCase } from "./src/case-types";

interface Args {
  suite?: string;
  filter?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--suite") args.suite = argv[++i];
    else if (a === "--filter") args.filter = argv[++i];
    else if (a === "--json") args.json = true;
    else {
      console.error(`moh-evals: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function pinnedPassCount(suite: string): number | undefined {
  const pin = join(import.meta.dir, "suites", `${suite}.suite.json`);
  if (!existsSync(pin)) return undefined;
  return (JSON.parse(readFileSync(pin, "utf8")) as { expectedPass: number }).expectedPass;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const suites = args.suite ? [args.suite] : suiteNames();
  const results: SuiteResult[] = [];

  for (const suite of suites) {
    const cases = listCases(suite).filter((c) => !args.filter || c.includes(args.filter));
    const caseResults: CaseResult[] = [];
    for (const name of cases) {
      const file = join(import.meta.dir, "suites", suite, `${name}.json`);
      const spec = JSON.parse(readFileSync(file, "utf8")) as EvalCase | MultiRunCase;
      caseResults.push(await runCaseFile(suite, name, spec));
    }
    const pin = pinnedPassCount(suite);
    const pass = caseResults.filter((r) => r.pass).length;
    if (pin !== undefined && pass !== pin && !args.filter) {
      caseResults.push({
        suite,
        case: "(suite pin)",
        pass: false,
        exitCode: 0,
        failures: [`suite pin: expected ${pin} passing cases, got ${pass} — a change broke or altered case outcomes`],
      });
    }
    results.push({ suite, cases: caseResults, pass, fail: caseResults.length - pass });
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        results.map((s) => ({
          suite: s.suite,
          pass: s.pass,
          fail: s.fail,
          cases: s.cases.map((c) => ({ case: c.case, pass: c.pass, exitCode: c.exitCode, failures: c.failures })),
        })),
        null,
        2,
      ),
    );
  } else {
    for (const s of results) {
      console.log(`\nsuite: ${s.suite}  (${s.pass} pass, ${s.fail} fail)`);
      for (const c of s.cases) {
        console.log(`  ${c.pass ? "✓" : "✗"} ${c.case}`);
        for (const f of c.failures) {
          console.log(`      ${f}`);
        }
      }
    }
    const totalPass = results.reduce((n, s) => n + s.pass, 0);
    const totalFail = results.reduce((n, s) => n + s.fail, 0);
    console.log(`\ntotal: ${totalPass} pass, ${totalFail} fail`);
  }

  return results.some((s) => s.fail > 0) ? 1 : 0;
}

process.exitCode = await main();
