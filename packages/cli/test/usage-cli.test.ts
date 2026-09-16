/**
 * `moh usage` (#715): child-process e2e against an isolated HOME with
 * fixture sessions on disk — per-model table, --project/--days/--json
 * filters, empty-project friendly message, corrupt-file skip.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
    const oldFile = h.session((s) => {
      turn(s, "m-old", 100, 10);
    });
    h.session((s) => {
      turn(s, "m-new", 1, 1);
    });
    const { utimesSync } = await import("node:fs");
    // Age the first session's file (known by returned path, not readdir
    // order — two stores can mint within the same millisecond) by 30 days.
    const aged = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, aged, aged);
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

describe("moh usage tools (#716)", () => {
  test("--help mentions the sub-reports", () => {
    const { spawn } = harness();
    const { code, stdout } = spawn(["--help"]);
    expect(stdout).toContain("tools");
    expect(stdout).toContain("routes");
    expect(code).toBe(0);
  });

  test("renders per-tool calls, ok/fail, timeouts, avg duration", () => {
    const h = harness();
    h.session((s) => {
      s.append({ type: "tool_call", callId: "c1", name: "bash", args: {} });
      s.append({ type: "tool_result", callId: "c1", ok: true, output: "ok" });
      s.append({ type: "tool_call", callId: "c2", name: "bash", args: {} });
      s.append({ type: "tool_result", callId: "c2", ok: false, output: "bash: timed out after 30000ms: x" });
      s.append({ type: "tool_call", callId: "c3", name: "read", args: {} });
      s.append({ type: "tool_result", callId: "c3", ok: true, output: "ok" });
    });
    const { code, stdout } = h.spawn(["tools"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Tool statistics");
    expect(stdout).toContain("bash");
    expect(stdout).toContain("1"); // 1 timeout
  });

  test("--json emits tool rows with avgDurationMs", () => {
    const h = harness();
    h.session((s) => {
      s.append({ type: "tool_call", callId: "c1", name: "read", args: {} });
      s.append({ type: "tool_result", callId: "c1", ok: true, output: "ok" });
    });
    const parsed = JSON.parse(h.spawn(["tools", "--json"]).stdout);
    expect(parsed.tools).toEqual([{ tool: "read", calls: 1, ok: 1, fail: 0, timeouts: 0, avgDurationMs: expect.any(Number) }]);
    expect(parsed.sessionsScanned).toBe(1);
  });

  test("empty project → friendly message, exit 0", () => {
    const { spawn } = harness();
    const { code, stderr, stdout } = spawn(["tools"]);
    expect(code).toBe(0);
    expect(stderr).toContain("No sessions found");
    expect(stdout).toBe("");
  });
});

describe("moh usage routes (#716)", () => {
  test("renders fallbacks, serving switches, and errors by kind", () => {
    const h = harness();
    h.session((s) => {
      s.append({ type: "fallback", from: "prov/alpha", to: "prov/beta", reason: "rate_limited" });
      s.append({ type: "fallback", from: "prov/alpha", to: "prov/beta", reason: "rate_limited" });
      s.append({ type: "fallback", from: "prov/alpha", to: "prov/gamma", reason: "overloaded" });
      s.append({ type: "route_serving", selected: "prov/alpha", serving: "prov/beta", previous: "prov/alpha" });
      s.append({ type: "error", reason: "context_length", message: "too long" });
      s.append({ type: "error", reason: "rate_limited", message: "limited" });
    });
    const { code, stdout } = h.spawn(["routes"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Fallback activations");
    expect(stdout).toContain("rate_limited");
    expect(stdout).toContain("Route serving switches");
    expect(stdout).toContain("Turn errors by kind");
    expect(stdout).toContain("context_length");
  });

  test("--json emits the route structure", () => {
    const h = harness();
    h.session((s) => {
      s.append({ type: "fallback", from: "a/p", to: "b/q", reason: "network" });
    });
    const parsed = JSON.parse(h.spawn(["routes", "--json"]).stdout);
    expect(parsed.route.fallbacks).toEqual([{ from: "a/p", to: "b/q", reason: "network", count: 1 }]);
    expect(parsed.route.routeServing).toEqual([]);
    expect(parsed.route.turnErrors).toEqual({});
  });

  test("clean sessions → all-zero route health, exit 0", () => {
    const h = harness();
    h.session((s) => {
      s.append({ type: "user_message", text: "work" });
    });
    const { code, stdout } = h.spawn(["routes"]);
    expect(code).toBe(0);
    expect(stdout).toContain("No fallback activations");
    expect(stdout).toContain("No turn errors");
  });

  test("empty project → friendly message, exit 0", () => {
    const { spawn } = harness();
    const { code, stderr, stdout } = spawn(["routes"]);
    expect(code).toBe(0);
    expect(stderr).toContain("No sessions found");
    expect(stdout).toBe("");
  });

  test("shared filters work: --days with tools sub-report", async () => {
    const h = harness();
    const oldFile = h.session((s) => {
      s.append({ type: "tool_call", callId: "c1", name: "old-tool", args: {} });
      s.append({ type: "tool_result", callId: "c1", ok: true, output: "ok" });
    });
    h.session((s) => {
      s.append({ type: "tool_call", callId: "c2", name: "new-tool", args: {} });
      s.append({ type: "tool_result", callId: "c2", ok: true, output: "ok" });
    });
    const { utimesSync } = await import("node:fs");
    const aged = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, aged, aged);
    const { code, stdout } = h.spawn(["tools", "--days", "7"]);
    expect(code).toBe(0);
    expect(stdout).toContain("new-tool");
    expect(stdout).not.toContain("old-tool");
  });
});

describe("moh usage export (#717)", () => {
  /** Fixture with rich content: the markers must never appear in exports. */
  function richHarness() {
    const h = harness();
    h.session((s) => {
      s.append({ type: "session_start", schemaVersion: 1, promptVersion: "p" });
      s.append({ type: "user_message", text: "SECRET-USER-PROMPT please refactor the widget" });
      s.append({ type: "model_call", model: "m-a", usage: { inputTokens: 100, outputTokens: 10 }, thinkingLevel: "high" });
      s.append({ type: "tool_call", callId: "c1", name: "bash", args: "SECRET-TOOL-ARGS cat /etc/passwd" });
      s.append({ type: "tool_result", callId: "c1", ok: true, output: "SECRET-TOOL-OUTPUT root:x:0:0" });
      s.append({ type: "fallback", from: "a/one", to: "a/two", reason: "rate_limited" });
      s.append({ type: "error", reason: "rate_limited", message: "rate limited" });
      s.append({ type: "done", usage: { inputTokens: 100, outputTokens: 10 }, models: ["m-a"] });
    });
    return h;
  }

  test("--format is required and validated", () => {
    const h = richHarness();
    const missing = h.spawn(["export"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--format csv|jsonl");
    const bad = h.spawn(["export", "--format", "xml"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--format csv|jsonl");
  });

  test("csv to stdout: metadata-only long format", () => {
    const h = richHarness();
    const { code, stdout } = h.spawn(["export", "--format", "csv"]);
    expect(code).toBe(0);
    expect(stdout).toContain("section,entity,metric,value");
    expect(stdout).toContain("model,m-a,calls,1");
    expect(stdout).toContain("model,m-a,inputTokens,100");
    expect(stdout).toContain("tool,bash,calls,1");
    expect(stdout).toContain("route_fallback,a/one -> a/two (rate_limited),count,1");
    expect(stdout).toContain("turn_error,rate_limited,count,1");
    // The rich content markers never leave the machine.
    expect(stdout).not.toContain("SECRET-USER-PROMPT");
    expect(stdout).not.toContain("SECRET-TOOL-ARGS");
    expect(stdout).not.toContain("SECRET-TOOL-OUTPUT");
  });

  test("jsonl to stdout: one record per line", () => {
    const h = richHarness();
    const { code, stdout } = h.spawn(["export", "--format", "jsonl"]);
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n").map((l) => JSON.parse(l));
    const model = lines.find((r) => r.section === "model");
    expect(model).toMatchObject({ section: "model", model: "m-a", calls: 1, inputTokens: 100, outputTokens: 10 });
    const session = lines.find((r) => r.section === "session");
    expect(session).toMatchObject({ id: session!.id, done: 1, error: 1, inputTokens: 100, modelsServed: ["m-a"] });
    expect(session.modelsServed).toEqual(["m-a"]);
    const tool = lines.find((r) => r.section === "tool");
    expect(tool).toMatchObject({ tool: "bash", calls: 1, ok: 1, fail: 0 });
    for (const line of stdout.trim().split("\n")) {
      expect(line).not.toContain("SECRET-");
    }
  });

  test("--out writes to a path and not stdout", () => {
    const h = richHarness();
    const outPath = join(h.cwd, "usage-export.csv");
    const { code, stdout } = h.spawn(["export", "--format", "csv", "--out", outPath]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("model,m-a,inputTokens,100");
    expect(written).not.toContain("SECRET-");
    rmSync(outPath);
  });

  test("csv values are escaped", () => {
    const h = harness();
    h.session((s) => {
      s.append({ type: "fallback", from: "x,a", to: "b", reason: `quote " and, comma` });
    });
    const { code, stdout } = h.spawn(["export", "--format", "csv"]);
    expect(code).toBe(0);
    expect(stdout).toContain('"x,a -> b (quote "" and, comma)",count,1');
  });

  test("empty project → friendly message, no output file", () => {
    const { spawn, cwd } = harness();
    const outPath = join(cwd, "never.csv");
    const { code, stderr } = spawn(["export", "--format", "csv", "--out", outPath]);
    expect(code).toBe(0);
    expect(stderr).toContain("No sessions found");
    expect(existsSync(outPath)).toBe(false);
  });

  test("relative --out refusing .. traversal outside the project root", () => {
    const h = richHarness();
    const { code, stderr } = h.spawn(["export", "--format", "csv", "--out", "../escape.csv"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--out must be an absolute path");
  });
});
