/**
 * `moh compact` (#466): forced compaction of a closed session file.
 * End-to-end over the CLI surface: usage, required --session, a real
 * compaction run (mock summarizer via moh.json-free config → the mock
 * provider writes the summary), and the "nothing to compact" refusal.
 * Compacting never consumes: no `session_resumed` event is appended.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { projectSlug } from "../../core/src/session-store";

const TMP_ROOT = join(tmpdir(), "moh-compact-cli");

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function project(name: string): { cwd: string; file: string } {
  mkdirSync(TMP_ROOT, { recursive: true });
  const cwd = mkdtempSync(join(TMP_ROOT, name + "-"));
  writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
  const sessDir = mkdtempSync(join(TMP_ROOT, name + "-sess-"));
  const file = join(sessDir, "session.jsonl");
  return { cwd, file };
}

/** A session file with 12 user turns (assistant reply + done each). */
function seed(file: string): void {
  const lines: Array<Record<string, unknown>> = [{ type: "session_start", schemaVersion: 1, promptVersion: "p" }];
  for (let i = 0; i < 12; i++) {
    lines.push(
      { type: "user_message", text: `turn ${i}` },
      { type: "assistant_delta", text: "reply" },
      { type: "done" },
      { type: "model_call", model: "mock", usage: { inputTokens: 100, outputTokens: 10 } },
    );
  }
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
}

function run(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => (stdout.push(s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => (stderr.push(s), true)) as typeof process.stderr.write;
  return main(argv).finally(() => {
    process.stdout.write = orig;
    process.stderr.write = origErr;
    void [stdout, stderr];
  }).then((code) => ({ code, out: stdout.join(""), err: stderr.join("") }));
}

describe("moh compact (#466)", () => {
  test("--help prints the usage", async () => {
    const { code, out } = await run(["compact", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: moh compact [--session <file>]");
  });

  test("requires --session when the project has no sessions (isolated HOME)", async () => {
    const origHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "moh-empty-home-"));
    try {
      const { code, err } = await run(["compact"]);
      expect(code).toBe(2);
      expect(err).toContain("--session <file> is required");
    } finally {
      process.env.HOME = origHome;
    }
  });

  test("without --session, compacts the project's most recent session", async () => {
    const { cwd, file } = project("recent");
    seed(file);
    // Discovery looks in <home>/.moh/projects/<slug>/; create the session
    // there via the core's own seam (project.json pins the slug).
    mkdirSync(join(cwd, ".moh"), { recursive: true });
    writeFileSync(join(cwd, ".moh", "project.json"), `${JSON.stringify({ id: "compact-cli-recent" })}\n`);
    const home = mkdtempSync(join(TMP_ROOT, "recent-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const slugDir = join(home, ".moh", "projects", projectSlug(cwd, home));
      mkdirSync(slugDir, { recursive: true });
      const discovered = join(slugDir, "20260903T010000123Z-0badf00d.jsonl");
      seed(discovered);
      const before = readFileSync(discovered, "utf8");
      const { code, out } = await run(["compact", "--cwd", cwd]);
      expect(code).toBe(0);
      expect(out).toContain(discovered);
      const after = readFileSync(discovered, "utf8");
      expect(after.startsWith(before)).toBe(true);
      expect(after).toContain('"compaction"');
      expect(after).not.toContain("session_resumed");
    } finally {
      process.env.HOME = origHome;
    }
    void file;
  });

  test("compacts a seeded session file in place", async () => {
    const { cwd, file } = project("ok");
    seed(file);
    const before = readFileSync(file, "utf8");
    const { code, out, err } = await run(["compact", "--session", file, "--cwd", cwd]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("compacted");
    // Append-only: the log only grew, and exactly one marker was added.
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const markers = after.split("\n").filter((l) => l.includes('"compaction"'));
    expect(markers).toHaveLength(1);
    const marker = JSON.parse(markers[0]!) as { type: string; summary: string; upTo: number };
    expect(marker.summary.length).toBeGreaterThan(0);
    expect(marker.upTo).toBeGreaterThan(0);
    // Compacting never consumes (ADR-0022): no session_resumed at all.
    expect(after).not.toContain("session_resumed");
  });

  test("refuses a session with nothing to compact", async () => {
    const { cwd, file } = project("small");
    writeFileSync(file, JSON.stringify({ type: "session_start", schemaVersion: 1, promptVersion: "p" }) + "\n", { mode: 0o600 });
    const { code, err } = await run(["compact", "--session", file, "--cwd", cwd]);
    expect(code).toBe(1);
    expect(err).toContain("nothing to compact");
  });
});