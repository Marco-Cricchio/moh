/**
 * The shared harness for CLI end-to-end tests (#1142).
 *
 * Every test here runs the real CLI in a **child process**, which means its
 * cost is dominated by `bun`'s startup (parsing and compiling `src/cli.ts`)
 * rather than by the assertion. Measured on an idle machine: ~300–900 ms per
 * child; with a dozen children in flight (bun test runs a file's tests
 * sequentially, but several files in one `bun test packages/cli` process,
 * plus whatever else CI is running) the same child costs 2.5–10 s.
 *
 * bun's per-test default budget is **5 s**, so a suite of spawn-based tests
 * is a coin flip under load: the same commit failed on CI at 5008 ms and
 * passed on an identical re-run at 537 ms (#1132, the `cli` job). Raising
 * the ceiling is the honest fix — the assertion is not slow, the machine is
 * busy. It is NOT a substitute for determinism: a test that fails
 * *logically* must still fail.
 *
 * Two exports:
 *
 * - `SPAWN_TEST_TIMEOUT_MS` — pass as the third argument of `test(...)` for
 *   every spawn-based test.
 * - `runCli` — spawns `src/cli.ts` with an isolated `HOME`, pipes both
 *   streams, and decodes them; the one place the argv shape lives.
 */
import { join } from "node:path";

/** A child-process budget with real headroom over the observed worst case
 * (~10 s), while still failing a genuine hang in a useful time. */
export const SPAWN_TEST_TIMEOUT_MS = 60_000;

export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  /** Working directory the child runs in (the project under test). */
  cwd: string;
  /** The isolated `HOME` the child sees. */
  home: string;
  /** Extra environment on top of `process.env` + `HOME`. */
  env?: Record<string, string | undefined>;
  /** Replace the child's stdin (defaults to "ignore": closed, so a
   * command that would prompt reads EOF instead of hanging on a tty). */
  stdin?: "ignore";
}

/** The CLI entry point, resolved from this file so the harness works no
 * matter which package the caller lives in. */
const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

/**
 * Runs `moh <argv>` in a child process and returns its exit code and both
 * streams decoded. The argv is `[bun, src/cli.ts, ...argv]`, the argv shape
 * every CLI e2e test repeats by hand.
 */
export function runCli(argv: string[], options: CliRunOptions): CliRunResult {
  const proc = Bun.spawnSync([process.execPath, CLI_ENTRY, ...argv], {
    cwd: options.cwd,
    env: { ...process.env, HOME: options.home, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin ?? "ignore",
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}
