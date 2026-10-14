/**
 * S0.1/B2 scenario runner + `compare` mode.
 *
 *   bun scripts/ablation-baseline/b2.ts record <outDir> [--only <name>...]
 *   bun scripts/ablation-baseline/b2.ts compare <dirA> <dirB>
 *
 * record: runs every scenario in its OWN child process (bun snapshots
 *   os.homedir() at startup, so pinning HOME per scenario requires a
 *   process boundary — subagent child logs default to homedir()) with an
 *   isolated temp home/cwd, and writes
 *   <outDir>/<scenario>/{events.jsonl,requests.json,results.json,fs.json}
 *   normalized per 00-safety-net § 2 B2.
 * compare: diffs two output trees file by file; exits non-zero on ANY
 *   difference (missing/extra files included).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { sessionFromConfig } from "@moh/core";
import { buildScenarios } from "./scenarios";
import { Normalizer } from "./normalize";
import type { ScenarioContext, ScenarioRun } from "./scenarios";
import { RecordingProvider } from "./recording-provider";

function usage(): never {
  console.error("usage: b2.ts record <outDir> [--only <name>...] | b2.ts compare <dirA> <dirB>");
  process.exit(2);
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "record" && args[0]) return record(args[0], args.slice(1));
  if (cmd === "compare" && args[0] && args[1]) return compare(args[0], args[1]);
  if (cmd === "__child__" && args[0] && args[1] && args[2] && args[3]) return runOne(args[0], args[1], args[2], args[3]);
  usage();
}

/* ------------------------------ record ------------------------------ */

function walkTree(root: string, base = root, skipDirs: string[] = []): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    if (entry.isDirectory() && skipDirs.includes(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkTree(full, base, skipDirs));
    else out.push(relative(base, full));
  }
  return out;
}

function fileMode(file: string): string {
  return (statSync(file).mode & 0o777).toString(8).padStart(3, "0");
}

/** Locale-free key compare that orders `<session:12>` after `<session:2>`
 * (numeric token order, not lexicographic) and everything else byte-wise. */
function stableKeyCompare(a: string, b: string): number {
  const chunk = (s: string): { tag?: string; n?: number; s: string }[] =>
    s.split(/(<[a-z0-9]+:\d+>)/).map((part) => {
      const m = /^<([a-z0-9]+):(\d+)>$/.exec(part);
      return m ? { tag: m[1]!, n: Number(m[2]), s: part } : { s: part };
    });
  const A = chunk(a);
  const B = chunk(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x.n === "number" && typeof y.n === "number") {
      if (x.n !== y.n) return x.n - y.n;
      continue;
    }
    if (x.s < y.s) return -1;
    if (x.s > y.s) return 1;
  }
  return 0;
}

async function record(outDir: string, rest: string[]): Promise<number> {
  const onlyIdx = rest.indexOf("--only");
  const only = onlyIdx !== -1 ? rest.slice(onlyIdx + 1) : [];
  const scenarios = buildScenarios().filter((s) => only.length === 0 || only.includes(s.name));
  if (scenarios.length === 0) {
    console.error("no scenarios selected");
    return 2;
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let failures = 0;
  for (const spec of scenarios) {
    process.stderr.write(`[b2] ${spec.name} … `);
    const home = mkdtempSync(join(tmpdir(), "moh-b2-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "moh-b2-cwd-"));
    const proc = Bun.spawn([process.execPath, import.meta.path, "__child__", outDir, spec.name, home, cwd], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, HOME: home, TZ: "UTC" },
    });
    const code = await proc.exited;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (code !== 0) {
      failures += 1;
      process.stderr.write(`FAILED (exit ${code})\n`);
    } else {
      process.stderr.write("ok\n");
    }
  }
  return failures === 0 ? 0 : 1;
}

/** One scenario in this child process; HOME already points at the
 * scenario's temp home (bun's homedir snapshot is per-process). */
async function runOne(outDir: string, name: string, home: string, cwd: string): Promise<number> {
  const spec = buildScenarios().find((s) => s.name === name);
  if (!spec) {
    console.error(`unknown scenario: ${name}`);
    return 2;
  }
  const ctx: ScenarioContext = {
    home,
    cwd,
    file: (rel, content) => {
      const file = join(cwd, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
    config: {
      memory: { enabled: false },
      retro: { enabled: false },
      handoff: { transport: "none" },
    },
    consent: {},
    overrides: {},
    vars: new Map(),
  };
  const provider = spec.assemble(ctx);
  const recorders: RecordingProvider[] = [];
  const track = (p: unknown): void => {
    if (p instanceof RecordingProvider && !recorders.includes(p)) recorders.push(p);
  };
  track(provider);

  const assembled = sessionFromConfig({
    cwd,
    home,
    ...(provider ? { provider } : {}),
    config: ctx.config,
    consent: ctx.consent as never,
    overrides: ctx.overrides as never,
  });
  if ("error" in assembled) {
    console.error(`assembly error: ${assembled.error.kind}: ${assembled.error.message}`);
    return 1;
  }
  const run: ScenarioRun = {
    session: assembled.session,
    store: assembled.store,
    providers: recorders,
    results: [],
  };
  try {
    await run.session.extensionsReady();
    await spec.body(ctx, run);
  } finally {
    try {
      await run.session.dispose();
    } catch {
      /* dispose is best-effort for the artifact dump below */
    }
  }

  // Artifacts, each with its own normalizer namespace.
  const eventsNorm = new Normalizer({ home, cwd });
  const requestsNorm = new Normalizer({ home, cwd });
  const resultsNorm = new Normalizer({ home, cwd });
  const fsNorm = new Normalizer({ home, cwd });

  const scenarioDir = join(outDir, spec.name);
  mkdirSync(scenarioDir, { recursive: true });

  // events.jsonl — normalized line by line (token order = log order).
  const rawEvents = readFileSync(run.store.file, "utf8");
  const events =
    rawEvents
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => eventsNorm.text(l))
      .join("\n") + "\n";
  writeFileSync(join(scenarioDir, "events.jsonl"), events);

  // requests.json — every recorded stream() call, in call order.
  const requests = recorders.flatMap((p, i) =>
    p.recorded.map((call, j) => ({
      recorder: i,
      call: j,
      model: p.name,
      messages: call.messages,
      tools: call.tools,
      options: call.options ?? null,
    })),
  );
  writeFileSync(
    join(scenarioDir, "requests.json"),
    JSON.stringify(requests, null, 2).split("\n").map((l) => requestsNorm.text(l)).join("\n") + "\n",
  );

  // results.json — TurnResults by label.
  writeFileSync(
    join(scenarioDir, "results.json"),
    JSON.stringify(run.results, null, 2).split("\n").map((l) => resultsNorm.text(l)).join("\n") + "\n",
  );

  // fs.json — home + cwd after dispose: relative path, mode, normalized
  // content (binary contents are recorded as <binary:length>). Keys are
  // sorted with <session:N> tokens compared numerically, so the random
  // file names of sibling session logs (parent + subagent children in
  // one project dir) cannot shuffle the listing between runs.
  const entries: [string, unknown][] = [];
  for (const [label, root] of [
    ["home", home],
    ["cwd", cwd],
  ] as const) {
    for (const rel of walkTree(root, root, label === "home" ? ["Library"] : [])) {
      const full = join(root, rel);
      const key = fsNorm.path(`${label}/${rel}`);
      const buf = readFileSync(full);
      const isText = !buf.includes(0);
      entries.push([
        key,
        {
          mode: fileMode(full),
          content: isText ? fsNorm.text(buf.toString("utf8")) : `<binary:${buf.length}>`,
        },
      ]);
    }
  }
  entries.sort((a, b) => stableKeyCompare(a[0], b[0]));
  const fsSnapshot: Record<string, unknown> = {};
  for (const [k, v] of entries) fsSnapshot[k] = v;
  writeFileSync(join(scenarioDir, "fs.json"), JSON.stringify(fsSnapshot, null, 2) + "\n");
  return 0;
}

/* ------------------------------ compare ------------------------------ */

function compare(dirA: string, dirB: string): number {
  let diffs = 0;
  const report = (msg: string): void => {
    diffs += 1;
    console.log(`DIFF ${msg}`);
  };
  const filesA = new Set(walkTree(dirA));
  const filesB = new Set(walkTree(dirB));
  for (const f of filesA) if (!filesB.has(f)) report(`only in ${dirA}: ${f}`);
  for (const f of filesB) if (!filesA.has(f)) report(`only in ${dirB}: ${f}`);
  for (const f of filesA) {
    if (!filesB.has(f)) continue;
    const textA = readFileSync(join(dirA, f), "utf8");
    const textB = readFileSync(join(dirB, f), "utf8");
    if (textA === textB) continue;
    report(`${f}`);
    const linesA = textA.split("\n");
    const linesB = textB.split("\n");
    const max = Math.max(linesA.length, linesB.length);
    let shown = 0;
    for (let i = 0; i < max && shown < 5; i++) {
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
    return 0;
  }
  console.log(`compare: ${diffs} difference(s)`);
  return 1;
}

process.exitCode = await main();
