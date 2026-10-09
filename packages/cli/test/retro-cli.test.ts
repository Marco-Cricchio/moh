/**
 * `moh retro` (#1275): the pull-based consumption door. In-process — the
 * command is a pure store read plus the gated apply, so no child process
 * is needed; the store is a real temp directory.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RetroStore } from "@moh/core";
import { retroCommand, RETRO_USAGE } from "../src/retro";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = join(tmpdir(), `moh-retro-cli-${prefix}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

/** Captures both streams for the duration of one command run. */
async function run(argv: string[], opts: { cwd: string; home: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    const code = await retroCommand({ argv, home: opts.home, cwd: opts.cwd });
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

/** Writes one finding into the project's store; the signature is read
 * back from the store, which owns the derivation. */
function seed(cwd: string, home: string, category = "navigation", evidence = "spent 12 calls locating the store") {
  // The CLI resolves the store from the user home (`~/.moh`); the seed
  // must land in the same place.
  const store = RetroStore.forProject(cwd, join(home, ".moh"));
  store.append([{ category, evidence, confidence: 0.7, session: "s-1", signature: `${category}:${evidence}` }]);
  return { store, signature: store.read()[0]!.signature };
}

describe("moh retro (#1275)", () => {
  test("usage is a real command surface", () => {
    expect(RETRO_USAGE).toContain("usage: moh retro");
    expect(RETRO_USAGE).toContain("--dismiss");
    expect(RETRO_USAGE).toContain("--apply");
  });

  test("an empty store reports nothing accumulated", async () => {
    const cwd = tempDir("cwd");
    const home = tempDir("home");
    const result = await run([], { cwd, home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No retro findings");
  });

  test("the report lists findings with their proposal and signature", async () => {
    const cwd = tempDir("cwd");
    const home = tempDir("home");
    const { signature } = seed(cwd, home);
    const result = await run([], { cwd, home });
    expect(result.stdout).toContain("[navigation] confidence 70%");
    expect(result.stdout).toContain("spent 12 calls locating the store");
    expect(result.stdout).toContain("add a navigation pointer");
    expect(result.stdout).toContain(signature);
  });

  test("--json emits the report structure", async () => {
    const cwd = tempDir("cwd");
    const home = tempDir("home");
    seed(cwd, home);
    const result = await run(["--json"], { cwd, home });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ category: string }> };
    expect(parsed.findings[0]?.category).toBe("navigation");
  });

  test("--dismiss records a durable dismissal and drops it from the report", async () => {
    const cwd = tempDir("cwd");
    const home = tempDir("home");
    const { store, signature } = seed(cwd, home);
    const result = await run(["--dismiss", signature], { cwd, home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dismissed");
    expect(store.dismissed().has(signature)).toBe(true);
    const after = await run([], { cwd, home });
    expect(after.stdout).toContain("No retro findings");
  });

  test("an unknown signature is refused, never silently accepted", async () => {
    const cwd = tempDir("cwd");
    const home = tempDir("home");
    seed(cwd, home);
    const result = await run(["--dismiss", "nope"], { cwd, home });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no finding with signature");
  });

  test("--apply without --yes shows the proposal and writes nothing", async () => {
    const cwd = tempDir("cwd");
    const home = tempDir("home");
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n");
    const { signature } = seed(cwd, home);
    const result = await run(["--apply", signature], { cwd, home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("add a navigation pointer");
    expect(result.stdout).toContain("--yes to apply");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe("# Agents\n");
  });

  test("--apply --yes writes the marked bullet once", async () => {
    const cwd = tempDir("cwd");
    const home = tempDir("home");
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n\nExisting prose.\n");
    const { signature } = seed(cwd, home);
    const first = await run(["--apply", signature, "--yes"], { cwd, home });
    expect(first.code).toBe(0);
    const written = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(written).toContain("Existing prose.");
    expect(written).toContain("## Retro findings");
    const second = await run(["--apply", signature, "--yes"], { cwd, home });
    expect(second.stdout).toContain("already applied");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(written);
  });

  test("a confirmed apply refuses a missing target instead of creating it", async () => {
    const cwd = tempDir("cwd");
    const home = tempDir("home");
    const { signature } = seed(cwd, home, "coding-standards", "no guardrail caught this");
    const result = await run(["--apply", signature, "--yes"], { cwd, home });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not exist");
  });
});
