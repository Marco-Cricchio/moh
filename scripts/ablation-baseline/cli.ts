// S0.2/B3 CLI transcripts.
//
//   bun scripts/ablation-baseline/cli.ts <outDir>
//
// Runs every non-interactive subcommand against a deterministic fixture
// HOME (seeded sessions with fixed ULIDs, an api-key endpoint, a trash
// entry) and records stdout/stderr/exit code per command under
// <outDir>/cli/. Network-touching commands run with the network blocked
// (dead proxy) and must fail the same way every time.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectSlug } from "@moh/core";
import { Normalizer } from "./normalize";

const REPO = join(import.meta.dir, "..", "..");
const CLI = join(REPO, "packages/cli/src/cli.ts");

/** Fixed ULIDs (valid Crockford base32, 26 chars) for seeded logs. */
const SEED_ULIDS = [
  "01M4V7J7QVD9KRMGCBTQH01F8H",
  "01M4V7J7QX9DRWGNP4DYFAXPEA",
  "01M4V7J7QZGYE7KAH3JARJPKB8",
  "01M4V7J7S22TV8XK4E9FQ1N7HC",
  "01M4V7J7S4M3QD2WBY8TZK6RPE",
  "01M4V7J7S6C5HJ4XGZQ2V9TDNB",
];

function seedSession(
  file: string,
  title: string,
  extra: string[] = [],
): void {
  const lines = [
    JSON.stringify({ type: "session_start", schemaVersion: 2, promptVersion: "seed", id: SEED_ULIDS[0], prevHash: "" }),
    JSON.stringify({ type: "user_message", text: title, id: SEED_ULIDS[1], parentId: SEED_ULIDS[0] }),
    ...extra,
    JSON.stringify({ type: "done", id: SEED_ULIDS[3], parentId: SEED_ULIDS[2] }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
}

interface Fixture {
  home: string;
  cwd: string;
  slug: string;
  sessionA: string;
  sessionB: string;
  trashed: string;
}

function buildFixture(base: string): Fixture {
  const home = join(base, "home");
  const cwd = join(base, "project");
  mkdirSync(join(home, ".moh"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(home, ".moh", "config"),
    JSON.stringify(
      {
        endpoints: [
          { name: "baseline-ep", type: "deepseek", apiKey: "test-key", defaultModel: "deepseek-chat" },
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(cwd, "moh.json"),
    JSON.stringify({ provider: "mock", handoff: { transport: "none" } }, null, 2) + "\n",
  );
  const slug = projectSlug(cwd, home);
  const projectDir = join(home, ".moh", "projects", slug);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const sessionA = join(projectDir, "20260101T000000000Z-11111111.jsonl");
  const sessionB = join(projectDir, "20260102T000000000Z-22222222.jsonl");
  const sessionC = join(projectDir, "20260103T000000000Z-44444444.jsonl");
  seedSession(sessionA, "alpha seeded session");
  seedSession(sessionB, "beta seeded session", [
    JSON.stringify({ type: "assistant_delta", text: "seeded reply", id: SEED_ULIDS[2], parentId: SEED_ULIDS[1] }),
  ]);
  seedSession(sessionC, "gamma seeded session");
  const trashDir = join(home, ".moh", "trash", "projects", slug);
  mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const trashed = join(trashDir, "20251231T000000000Z-33333333.jsonl");
  seedSession(trashed, "trashed seeded session");
  return { home, cwd, slug, sessionA, sessionB, trashed };
}

interface CliRun {
  slug: string;
  args: string[];
  fixture: Fixture;
  env?: Record<string, string>;
  /** Scripted stdin (confirmation prompts); closed immediately after. */
  stdin?: string;
}

async function runCli(run: CliRun): Promise<{ stdout: string; stderr: string; exit: number }> {
  const proc = Bun.spawn([process.execPath, CLI, ...run.args], {
    cwd: run.fixture.cwd,
    env: {
      ...process.env,
      HOME: run.fixture.home,
      TZ: "UTC",
      MOH_ENDPOINT_TEST_API_KEY: "",
      ...run.env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: run.stdin !== undefined ? "pipe" : "ignore",
  });
  if (run.stdin !== undefined) {
    const sink = proc.stdin as unknown as { write(s: string): number; flush(): void; end(): void };
    sink.write(run.stdin);
    sink.flush();
    sink.end();
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exit };
}

const NET_BLOCKED = {
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "",
};

/** Single-prompt eval cases: prompt + inline cassette + permissions. */
function evalCases(): { slug: string; prompt: string; cassette: string; allow: string[]; deny: string[] }[] {
  const out: { slug: string; prompt: string; cassette: string; allow: string[]; deny: string[] }[] = [];
  const suites = readdirSync(join(REPO, "packages/evals/suites")).filter((d) => !d.endsWith(".json"));
  for (const suite of suites.sort()) {
    for (const file of readdirSync(join(REPO, "packages/evals/suites", suite)).sort()) {
      if (!file.endsWith(".json")) continue;
      const json = JSON.parse(readFileSync(join(REPO, "packages/evals/suites", suite, file), "utf8")) as {
        prompt?: string;
        cassette?: unknown;
        permissions?: { allow?: string[]; deny?: string[] };
        steps?: unknown;
      };
      if (json.steps !== undefined || json.prompt === undefined || json.cassette === undefined) continue;
      out.push({
        slug: `run-eval-${suite}-${file.replace(/\.json$/, "")}`,
        prompt: json.prompt,
        cassette: JSON.stringify(json.cassette),
        allow: json.permissions?.allow ?? [],
        deny: json.permissions?.deny ?? [],
      });
    }
  }
  return out;
}

async function main(): Promise<number> {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: cli.ts <outDir>");
    process.exit(2);
  }
  rmSync(outDir, { recursive: true, force: true });

  // Two fixtures: the seeded one drives listings; a separate one collects
  // the `run --cassette` turns so their session files never enter the
  // listings' aggregate state.
  const seedBase = mkdtempSync(join(tmpdir(), "moh-b3-seed-"));
  const runsBase = mkdtempSync(join(tmpdir(), "moh-b3-runs-"));
  const seedFixture = buildFixture(seedBase);
  const runsFixture = buildFixture(runsBase);

  const commands: CliRun[] = [];
  const add = (slug: string, args: string[], env?: Record<string, string>, stdin?: string): void => {
    commands.push({ slug, args, fixture: seedFixture, env, stdin });
  };

  // Help surfaces + top-level errors.
  add("help", ["help"]);
  add("flag-help", ["--help"]);
  add("version", ["--version"]);
  add("version-extra", ["--version", "junk"]);
  add("removed-flag", ["--dangerously-bypass-permissions"]);
  add("yolo-misplaced", ["--yolo", "junk"]);
  add("unknown-command", ["definitely-not-a-command"]);
  for (const sub of [
    "run", "serve", "mcp", "extension", "provider", "manual", "compact",
    "mpm", "sessions", "trash", "lanes", "usage", "jev", "secret",
    "handoff", "browser", "retro",
  ]) {
    add(`help-${sub}`, [sub, "--help"]);
  }

  // Sessions (id = file name stem, per SESSIONS_USAGE).
  const idA = "20260101T000000000Z-11111111";
  const idB = "20260102T000000000Z-22222222";
  const idC = "20260103T000000000Z-44444444";
  add("sessions-analyze", ["sessions", "analyze", idA]);
  add("sessions-analyze-json", ["sessions", "analyze", idA, "--json"]);
  add("sessions-tree", ["sessions", "tree", idA]);
  add("sessions-rename", ["sessions", "rename", idA, "renamed alpha"]);
  add("sessions-bookmark", ["sessions", "bookmark", idA, SEED_ULIDS[1], "seed-bookmark"]);
  add("sessions-bookmark-name", ["sessions", "switch", idA, "seed-bookmark"]);
  add("sessions-switch-ulid", ["sessions", "switch", idA, SEED_ULIDS[1]]);
  add("sessions-delete-yes", ["sessions", "delete", idA, "--yes"]);
  add("sessions-delete-declined", ["sessions", "delete", idB]);
  add("sessions-delete-confirmed", ["sessions", "delete", idC], undefined, "y\n");
  add("sessions-unknown", ["sessions", "analyze", "20990101T000000000Z-ffffffff"]);

  // Trash.
  add("trash-list", ["trash", "list"]);
  add("trash-restore", ["trash", "restore", "20251231T000000000Z-33333333"]);

  // Usage reports.
  add("usage-default", ["usage"]);
  add("usage-tools", ["usage", "tools"]);
  add("usage-routes", ["usage", "routes"]);
  add("usage-export", ["usage", "export"]);

  // Status surfaces.
  add("mpm", ["mpm"]);
  add("mpm-json", ["mpm", "--json"]);
  add("jev-status", ["jev", "status"]);
  add("jev-status-json", ["jev", "status", "--json"]);
  add("secret-list", ["secret", "list"]);
  add("extension-list", ["extension", "list"]);
  add("provider-status", ["provider", "status"]);
  add("mcp", ["mcp"]);
  add("browser-status", ["browser", "status"]);
  add("manual-index", ["manual"]);
  add("manual-page", ["manual", "sessions"]);
  add("lanes-list", ["lanes", "list"]);
  add("retro", ["retro"]);

  // Usage-error paths.
  add("sessions-unknown-flag", ["sessions", "--frob"]);
  add("run-cassette-missing-value", ["run", "--cassette"]);
  add("jev-bad-usecase", ["jev", "not-a-use-case", "on"]);
  add("trash-no-args", ["trash"]);

  // Network-blocked commands: they must fail identically every run.
  add("update-blocked", ["update"], NET_BLOCKED);
  add("provider-login-blocked", ["provider", "login", "anthropic"], NET_BLOCKED);

  // `moh run --cassette` over the single-prompt eval cases (own fixture;
  // cassettes live under that fixture's cwd so echoed paths normalize).
  const cassetteDir = join(runsFixture.cwd, "cassettes");
  mkdirSync(cassetteDir, { recursive: true });
  for (const c of evalCases()) {
    const cassetteFile = join(cassetteDir, `${c.slug}.json`);
    writeFileSync(cassetteFile, c.cassette);
    const args = ["run", "--cassette", cassetteFile];
    for (const a of c.allow) args.push("--allow", a);
    for (const d of c.deny) args.push("--deny", d);
    args.push(c.prompt);
    commands.push({ slug: c.slug, args, fixture: runsFixture });
  }

  mkdirSync(join(outDir, "cli"), { recursive: true });
  let failures = 0;
  for (const run of commands) {
    process.stderr.write(`[b3] ${run.slug} … `);
    try {
      const { stdout, stderr, exit } = await runCli(run);
      const norm = new Normalizer({ home: run.fixture.home, cwd: run.fixture.cwd });
      const text = (s: string): string => s.split("\n").map((l) => norm.text(l, "display")).join("\n");
      writeFileSync(
        join(outDir, "cli", `${run.slug}.txt`),
        [
          text(`$ moh ${run.args.join(" ")}`),
          `exit: ${exit}`,
          "--- stdout ---",
          text(stdout).replace(/\n$/, ""),
          "--- stderr ---",
          text(stderr).replace(/\n$/, ""),
          "",
        ].join("\n"),
      );
      process.stderr.write(`exit ${exit}\n`);
    } catch (e) {
      failures += 1;
      process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  rmSync(seedBase, { recursive: true, force: true });
  rmSync(runsBase, { recursive: true, force: true });
  console.log(`cli: ${commands.length} transcripts, ${failures} failures`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
