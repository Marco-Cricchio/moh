/**
 * `moh usage` (#715): child-process e2e against an isolated HOME with
 * fixture sessions on disk — per-model table, --project/--days/--json
 * filters, empty-project friendly message, corrupt-file skip.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@moh/core";

const TMP_ROOT = join(tmpdir(), "moh-usage-cli");

function harness() {
  mkdirSync(TMP_ROOT, { recursive: true });
  const home = mkdtempSync(join(TMP_ROOT, "home-"));
  const cwd = mkdtempSync(join(TMP_ROOT, "proj-"));
  writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
  const spawn = (argv: string[]) => {
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "usage", ...argv],
      { cwd, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    return {
      code: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  };
  const session = (fn: (store: SessionStore) => void): string => {
    const store = SessionStore.create(cwd, home);
    fn(store);
    store.dispose();
    return store.file;
  };
  return { home, cwd, spawn, session };
}

function turn(store: SessionStore, model: string, input: number, output: number): void {
  store.append({ type: "user_message", text: "work" });
  store.append({ type: "model_call", model, usage: { inputTokens: input, outputTokens: output } });
  store.append({ type: "done", usage: { inputTokens: input, outputTokens: output }, models: [model] });
}

describe("moh usage (#715)", () => {
  test("--help prints the usage", () => {
    const { spawn } = harness();
    const { code, stdout } = spawn(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: moh usage");
  });

  test("empty project → friendly message, exit 0", () => {
    const { spawn } = harness();
    const { code, stderr, stdout } = spawn([]);
    expect(code).toBe(0);
    expect(stderr).toContain("No sessions found");
    expect(stdout).toBe("");
  });

  test("prints a per-model table across sessions", () => {
    const h = harness();
    h.session((s) => {
      s.append({ type: "session_start", schemaVersion: 1, promptVersion: "p" });
      turn(s, "m-a", 100, 10);
    });
    h.session((s) => {
      s.append({ type: "session_start", schemaVersion: 1, promptVersion: "p" });
      turn(s, "m-a", 50, 5);
      turn(s, "m-b", 7, 70);
      // failed calls are excluded (same convention as the quota rollup)
      s.append({ type: "model_call", model: "m-b", usage: { inputTokens: 999, outputTokens: 999 }, failed: true });
    });
    const { code, stdout } = h.spawn([]);
    expect(code).toBe(0);
    expect(stdout).toContain("m-a");
    expect(stdout).toContain("m-b");
    expect(stdout).toContain("150"); // 100+50 input for m-a
    expect(stdout).toContain("70"); // output for m-b
    expect(stdout).toContain("2 sessions");
    expect(stdout).not.toContain("999");
  });

  test("--json emits the aggregate structure", () => {
    const h = harness();
    h.session((s) => {
      turn(s, "m-a", 100, 10);
    });
    const { code, stdout } = h.spawn(["--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.models).toEqual([{ model: "m-a", calls: 1, inputTokens: 100, outputTokens: 10 }]);
    expect(parsed.totals).toEqual({ calls: 1, inputTokens: 100, outputTokens: 10 });
    expect(parsed.sessionsScanned).toBe(1);
  });

  test("--days filters sessions by mtime", async () => {
    const h = harness();
    h.session((s) => {
      turn(s, "m-old", 100, 10);
    });
    h.session((s) => {
      turn(s, "m-new", 1, 1);
    });
    const { readdirSync } = await import("node:fs");
    const slug = readdirSync(join(h.home, ".moh", "projects"))[0]!;
    const projectDir = join(h.home, ".moh", "projects", slug);
    const files = readdirSync(projectDir).sort();
    // Touch both to now, then age the older session file by 30 days.
    const old = files[0]!;
    const recent = files[1]!;
    const now = new Date();
    utimesSync(join(projectDir, recent), now, now);
    const aged = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(join(projectDir, old), aged, aged);
    const { code, stdout } = h.spawn(["--days", "7"]);
    expect(code).toBe(0);
    expect(stdout).toContain("m-new");
    expect(stdout).not.toContain("m-old");
    const json = JSON.parse(h.spawn(["--days", "7", "--json"]).stdout);
    expect(json.sessionsScanned).toBe(1);
  });

  test("--project reads another project's slug", () => {
    const h = harness();
    h.session((s) => {
      turn(s, "m-other", 42, 4);
    });
    
    const slug = readdirSync(join(h.home, ".moh", "projects"))[0]!;
    // From a fresh project cwd, --project points at the other slug.
    const otherCwd = mkdtempSync(join(TMP_ROOT, "other-"));
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "usage", "--project", slug, "--json"],
      { cwd: otherCwd, env: { ...process.env, HOME: h.home }, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(parsed.models[0]!.model).toBe("m-other");
    rmSync(otherCwd, { recursive: true, force: true });
  });

  test("corrupt session files are skipped, not fatal", () => {
    const h = harness();
    h.session((s) => {
      turn(s, "m-a", 100, 10);
    });
    
    const slug = readdirSync(join(h.home, ".moh", "projects"))[0]!;
    writeFileSync(join(h.home, ".moh", "projects", slug, "broken.jsonl"), "{not json\n");
    const { code, stdout, stderr } = h.spawn([]);
    expect(code).toBe(0);
    expect(stdout).toContain("m-a");
    expect(stderr).toContain("1 unreadable");
  });

  test("rejects a bad --days value", () => {
    const { spawn } = harness();
    const { code, stderr } = spawn(["--days", "nope"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--days expects a positive whole number");
  });

  test("rejects unexpected positionals", () => {
    const { spawn } = harness();
    const { code } = spawn(["junk"]);
    expect(code).toBe(2);
  });
});
